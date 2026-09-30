import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  NODE_ONLINE_DROP_CONFIRM_CHECKS,
  NODE_ONLINE_DROP_MIN_BASELINE,
  NODE_ONLINE_DROP_PCT,
  NODE_ONLINE_DROP_WINDOW_MIN,
  type RemnawaveNode,
} from '@nodeservice/shared';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersService } from '../servers/servers.service.js';
import { describeAnomaly } from './block-check.logic.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';
import { NodeBlockCheckService } from './node-block-check.service.js';
import { resolveUpstreamTarget } from './upstream-target.js';

const TICK_MS = 60_000;
/** Не открывать новый инцидент по той же ноде чаще, чем раз во столько минут (в основном страховка для
 * нод без своего сервера в панели — у сопоставленных дубль и так не даст завести база данных). */
const COOLDOWN_MIN = 30;

interface Sample {
  online: number;
  checkedAt: string;
}

/** Просадка увидена, но ещё не открыта — ждёт подтверждения следующим снимком (см. коммент к checkNode). */
interface Candidate {
  baselineOnline: number;
  /** Сколько снимков подряд уже показали просадку (первый — сама находка). */
  seen: number;
}

/** Подтверждённое падение онлайна, которое пора разбирать. */
interface Drop {
  node: RemnawaveNode;
  before: number;
  after: number;
}

/**
 * J10: аномалия онлайна ноды Remnawave (решения владельца 27.09.2026, уточнение 28.09.2026, поправка
 * 28.09.2026 про короткие просадки). Раз в минуту сравнивает свежий снимок Remnawave с предыдущим по
 * каждой ноде; сами данные обновляются реже (см. REMNAWAVE_SYNC_INTERVAL_MIN), поэтому по факту
 * сравнение идёт между двумя последними РАЗНЫМИ снимками — этого достаточно для порога «за 5 минут».
 * Резкое падение онлайна не открывает инцидент сразу: обычная перезагрузка сервера тоже на секунды
 * роняет онлайн до нуля и сама поднимается. Первое обнаружение — только кандидат; открываем инцидент,
 * лишь если просадку показали три снимка подряд (NODE_ONLINE_DROP_CONFIRM_CHECKS, решение владельца
 * 29.09.2026; снимки Remnawave — раз в минуту, то есть пара минут). Если онлайн за это время вернулся —
 * инцидент не заводим вовсе, тихо. Важность и заголовок открытого честно отражают результат встречной
 * проверки: подтвердилась блокировка — крит, проверка прошла чисто или не смогла отработать —
 * предупреждение без слова «блокировка» в заголовке.
 */
@Injectable()
export class NodeAnomalyJob {
  private readonly log = new Logger(NodeAnomalyJob.name);
  private readonly lastSample = new Map<string, Sample>();
  private readonly pending = new Map<string, Candidate>();
  private readonly cooldownUntil = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly remnawave: RemnawaveService,
    private readonly servers: ServersService,
    private readonly incidents: IncidentsRepository,
    private readonly blockCheck: NodeBlockCheckService,
    private readonly notifications: NotificationsService,
    private readonly incidentsService: IncidentsService,
  ) {}

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const status = await this.remnawave.status();
      if (!status.connected || !status.checkedAt) return;
      // Опрос Remnawave не удался: в снимке новое время, но числа прежние. Считать его новой проверкой
      // нельзя — иначе «три снимка подряд» набрались бы на одном настоящем.
      if (status.error) return;
      // Сначала смотрим все ноды, потом разбираем подтверждённые падения: так видно, упал онлайн у одной
      // ноды или сразу у нескольких (общая причина вероятнее неоплаты одного сервера).
      const due: Drop[] = [];
      for (const node of status.nodes) {
        const drop = this.checkNode(node, status.checkedAt);
        if (drop) due.push(drop);
      }
      if (due.length === 0) return;
      for (const drop of due) {
        await this.investigate(drop.node, drop.before, drop.after, due.length - 1).catch((err) =>
          this.log.warn(
            `Проверка блокировки ноды «${drop.node.name}»: ${err instanceof Error ? err.message : err}`,
          ),
        );
      }
    } catch (err) {
      this.log.warn(`Тик аномалии онлайна: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  /** Учесть свежий снимок ноды; вернуть падение, если оно подтвердилось и его пора разбирать. */
  private checkNode(node: RemnawaveNode, checkedAt: string): Drop | null {
    // Ноду выключили в Remnawave вручную: онлайн у неё пропал по решению администратора — это не сбой.
    // Забываем и прежний онлайн: после включения он растёт с нуля, и сравнивать его не с чем.
    if (node.isDisabled) {
      this.pending.delete(node.uuid);
      this.lastSample.delete(node.uuid);
      return null;
    }
    const prev = this.lastSample.get(node.uuid);
    const online = node.usersOnline ?? 0;
    // Тот же снимок Remnawave (данные ещё не обновились) — сравнивать пока не с чем, ждём следующего.
    if (prev && prev.checkedAt === checkedAt) return null;
    this.lastSample.set(node.uuid, { online, checkedAt });

    const candidate = this.pending.get(node.uuid);
    if (candidate) {
      const stillDown = online < candidate.baselineOnline * (1 - NODE_ONLINE_DROP_PCT / 100);
      if (stillDown && candidate.seen + 1 < NODE_ONLINE_DROP_CONFIRM_CHECKS) {
        // Просадка держится, но проверок подряд ещё мало — ждём следующий снимок.
        candidate.seen += 1;
        return null;
      }
      this.pending.delete(node.uuid);
      if (stillDown) {
        const until = this.cooldownUntil.get(node.uuid) ?? 0;
        if (Date.now() < until) return null;
        this.cooldownUntil.set(node.uuid, Date.now() + COOLDOWN_MIN * 60_000);
        return { node, before: candidate.baselineOnline, after: online };
      }
      // Поднялось само на следующей же проверке — инцидент не заводим, идём дальше как обычно.
    }

    if (!prev || prev.online < NODE_ONLINE_DROP_MIN_BASELINE) return null;
    const dropPct = ((prev.online - online) / prev.online) * 100;
    if (dropPct < NODE_ONLINE_DROP_PCT) return null;
    // Не открываем сразу — ждём подтверждения следующим снимком (см. коммент к классу).
    this.pending.set(node.uuid, { baselineOnline: prev.online, seen: 1 });
    return null;
  }

  private async investigate(
    node: RemnawaveNode,
    before: number,
    after: number,
    /** У скольких ещё нод онлайн упал в этом же проходе (дел по ним ещё нет). */
    sameTick = 0,
  ): Promise<void> {
    const allServers = await this.servers.list();
    const matched = allServers.find((s) => s.host === node.address) ?? null;
    // Сбой не у одного сервера — общая причина вероятнее неоплаты одного из них. Считаем так же, как
    // детекция связи: замолчавшие агенты, свежие дела «Сервер недоступен» и о падении онлайна у других;
    // своё прежнее дело (под именем ноды или сервера) «другим» не считается.
    const othersDown =
      sameTick +
      (await this.incidentsService
        .fleetTrouble({ serverId: matched?.id ?? null, names: [node.name, matched?.name] })
        .catch(() => 0));
    // Сервер ноды лежит целиком — онлайн упал поэтому, а не из-за блокировки. Отдельное дело не заводим:
    // пишем в «Сервер недоступен» (или его откроет детекция связи на ближайшем тике).
    if (matched) {
      const down = await this.incidents.findOpen(matched.id, 'server_down');
      const note = `Онлайн ноды «${node.name}» упал с ${before} до ${after} — следствие недоступности сервера, проверку блокировки не запускаю.`;
      if (down) {
        await this.incidents.appendEvent(down.id, {
          at: new Date().toISOString(),
          by: 'auto',
          action: note,
          result: 'detect',
        });
        return;
      }
    }
    const inbound = await this.remnawave.nodeInbound(node.uuid);
    const result = await this.blockCheck.check(
      node.name,
      node.address,
      inbound?.port ?? null,
      inbound?.sni ?? null,
      matched?.id ?? null,
      allServers,
    );
    // У выхода с указанным в профиле входом стучимся и во вход — видно, чья сторона сломалась.
    const target = await resolveUpstreamTarget(matched, allServers, this.remnawave).catch(() => null);
    if (target)
      result.entry = await this.blockCheck
        .checkEntry(target, matched?.id ?? null, allServers)
        .catch(() => null);
    // Оплата в окне (срок прошёл или наступит в ближайшие сутки) — вероятная причина, если блокировки нет.
    // Ноды нет среди серверов панели — «Биллинг» спросить не о чем: null, про оплату панель не утверждает.
    const payment = matched ? await this.incidentsService.paymentWindowFor(matched.id) : null;
    const described = describeAnomaly({
      nodeName: node.name,
      before,
      after,
      windowMin: NODE_ONLINE_DROP_WINDOW_MIN,
      result,
      portKnown: Boolean(inbound?.port),
      payment,
      // Агент на связи — сервер работает: закрытый порт ноды тогда не «сервер отключили».
      serverAlive: matched?.agentStatus === 'online',
      othersDown,
    });
    const { title, detail, confirmed } = described;
    // Агент на связи — сервер жив, порт закрыт у самой ноды или файрволом: это не «Сервер недоступен».
    const kind =
      described.kind === 'server_down' && matched?.agentStatus === 'online' ? 'node_blocked' : described.kind;
    // По серверу уже открыто «Недоступен из части сетей» — дописываем результат проверки блокировки туда
    // (иначе второе дело того же вида не откроется и находка потеряется).
    const partial = matched ? await this.incidents.findOpen(matched.id, 'node_blocked') : undefined;
    if (partial && kind === 'node_blocked') {
      await this.incidents.update(partial.id, { detail: `${partial.detail}\n\nПадение онлайна:\n${detail}` });
      await this.incidents.appendEvent(partial.id, {
        at: new Date().toISOString(),
        by: 'auto',
        action: `Онлайн ноды «${node.name}» упал с ${before} до ${after} — проверка блокировки: ${title}`,
        result: 'detect',
      });
      return;
    }
    const row = await this.incidents.open({
      serverId: matched?.id ?? null,
      serverName: matched?.name ?? node.name,
      kind,
      severity: confirmed || kind === 'server_down' ? 'crit' : 'warn',
      title,
      detail,
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    // Раньше такой инцидент писался только в базу: ни колокольчика, ни Telegram. Сообщаем как обычный.
    if (row)
      await this.notifications.push({
        severity: confirmed || kind === 'server_down' ? 'crit' : 'warn',
        title,
        body: detail,
        // Сервер привязываем, только если нода есть в NodeService: у уведомления ссылка на запись сервера.
        server: matched ? { id: matched.id, name: matched.name, host: node.address } : null,
        link: { to: `/incidents/${row.id}`, label: 'Открыть инцидент' },
        telegram: {
          event: confirmed || kind === 'server_down' ? 'incident_crit' : 'incident_warn',
          incidentId: row.id,
          kind,
          awaitAnalysis: await this.incidentsService.analysisWillFollow(),
          serverKey: matched?.id ?? `node:${node.uuid}`,
          server: { name: matched?.name ?? node.name, host: node.address },
        },
      });
  }
}
