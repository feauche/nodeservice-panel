import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  NODE_ONLINE_DROP_CONFIRM_CHECKS,
  NODE_ONLINE_DROP_MIN_BASELINE,
  NODE_ONLINE_DROP_PCT,
  type RemnawaveNode,
} from '@nodeservice/shared';
import type { IncidentRow } from '../../infra/db/schema/index.js';
import { NODE_ONLINE_METRIC } from '../fleet-stats/fleet-stats.service.js';
import { VmReaderService } from '../metrics/vm-reader.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { NodeLinkService } from '../remnawave/node-link.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersService } from '../servers/servers.service.js';
import { describeAnomaly } from './block-check.logic.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';
import {
  baselineFromDetail,
  ONLINE_RESTORE_MIN,
  type OnlineSample,
  onlineBaseline,
  samplesFromSeries,
  withSample,
} from './node-anomaly.logic.js';
import { NodeBlockCheckService } from './node-block-check.service.js';
import { resolveUpstream, unknownEntry } from './upstream-target.js';

const TICK_MS = 60_000;
/**
 * Не открывать новый инцидент по той же ноде чаще, чем раз во столько минут. Пауза живёт в памяти и при
 * перезапуске панели пропадает, поэтому перед открытием ещё ищется уже открытое дело этой ноды (у нод без
 * сервера в панели база данных дубль не остановит: правило «одно открытое дело на сервер и вид» для них
 * не действует).
 */
const COOLDOWN_MIN = 30;
/** Сколько раз после запуска пробовать прочитать сохранённые измерения, если хранилище не отвечает. */
const RESTORE_TRIES = 3;

/** Просадка увидена, но ещё не открыта — ждёт подтверждения следующим снимком (см. коммент к checkNode). */
interface Candidate {
  baselineOnline: number;
  /** Когда онлайн ещё был прежним — для «упал за N минут» в тексте дела. */
  baselineAt: number;
  /** Сколько снимков подряд уже показали просадку (первый — сама находка). */
  seen: number;
}

/** Подтверждённое падение онлайна, которое пора разбирать. */
interface Drop {
  node: RemnawaveNode;
  before: number;
  after: number;
  /** За сколько минут упал: от последнего снимка с прежним онлайном до подтверждения. */
  minutes: number;
}

/**
 * J10: аномалия онлайна ноды Remnawave (решения владельца 27.09.2026, уточнение 28.09.2026, поправка
 * 28.09.2026 про короткие просадки). Раз в минуту берёт свежий снимок Remnawave и сравнивает онлайн каждой
 * ноды с наибольшим за последние пять минут (решение владельца 30.09.2026: сравнение только с предыдущей
 * минутой пропускало падение ступеньками — 300 → 200 → 110 → 30). История снимков лежит в памяти; после
 * запуска панели она восстанавливается из сохранённых измерений онлайна, иначе падение, начавшееся перед
 * перезапуском, оставалось незамеченным: базой становился уже упавший онлайн.
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
  /** Снимки онлайна каждой ноды за окно сравнения, по возрастанию времени. */
  private readonly history = new Map<string, OnlineSample[]>();
  private readonly pending = new Map<string, Candidate>();
  private readonly cooldownUntil = new Map<string, number>();
  /** Сколько попыток восстановить историю осталось; 0 — восстановлена или больше не пробуем. */
  private restoreTries = RESTORE_TRIES;
  private busy = false;

  constructor(
    private readonly remnawave: RemnawaveService,
    private readonly servers: ServersService,
    private readonly incidents: IncidentsRepository,
    private readonly blockCheck: NodeBlockCheckService,
    private readonly notifications: NotificationsService,
    private readonly incidentsService: IncidentsService,
    private readonly vm: VmReaderService,
    private readonly links: NodeLinkService,
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
      const at = Date.parse(status.checkedAt);
      if (!Number.isFinite(at)) return;
      if (this.restoreTries > 0) await this.restore(at);
      // Сначала смотрим все ноды, потом разбираем подтверждённые падения: так видно, упал онлайн у одной
      // ноды или сразу у нескольких (общая причина вероятнее неоплаты одного сервера).
      const due: Drop[] = [];
      for (const node of status.nodes) {
        const drop = this.checkNode(node, at);
        if (drop) due.push(drop);
      }
      if (due.length === 0) return;
      for (const drop of due) {
        await this.investigate(drop, status.nodes, due.length - 1).catch((err) =>
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

  /**
   * После запуска: прежний онлайн нод — из сохранённых измерений (панель пишет их раз в минуту при каждом
   * чтении Remnawave). Читается один раз; хранилище не ответило — ещё пара попыток на следующих проходах.
   * Ноды, у которых снимки в памяти уже есть, не трогаем: память свежее.
   */
  private async restore(nowMs: number): Promise<void> {
    const end = Math.floor(nowMs / 1000);
    const series = await this.vm
      .queryRange(`last_over_time(${NODE_ONLINE_METRIC}[60s])`, end - ONLINE_RESTORE_MIN * 60, end, 60)
      .catch(() => null);
    this.restoreTries = series ? 0 : this.restoreTries - 1;
    if (!series) return;
    // Свежий снимок в измерения уже записан: точки не раньше него — это он сам, базой они быть не могут.
    for (const [uuid, samples] of samplesFromSeries(series))
      if (!this.history.has(uuid))
        this.history.set(
          uuid,
          samples.filter((s) => s.at < nowMs),
        );
  }

  /** Учесть свежий снимок ноды; вернуть падение, если оно подтвердилось и его пора разбирать. */
  private checkNode(node: RemnawaveNode, at: number): Drop | null {
    // Ноду выключили в Remnawave вручную: онлайн у неё пропал по решению администратора — это не сбой.
    // Забываем и прежний онлайн: после включения он растёт с нуля, и сравнивать его не с чем.
    if (node.isDisabled) {
      this.pending.delete(node.uuid);
      this.history.delete(node.uuid);
      return null;
    }
    const prior = this.history.get(node.uuid) ?? [];
    const online = node.usersOnline ?? 0;
    // Тот же снимок Remnawave (данные ещё не обновились) — сравнивать пока не с чем, ждём следующего.
    const last = prior.at(-1);
    if (last && at <= last.at) return null;
    const baseline = onlineBaseline(prior, at);
    this.history.set(node.uuid, withSample(prior, { at, online }));

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
        return {
          node,
          before: candidate.baselineOnline,
          after: online,
          minutes: Math.max(1, Math.round((at - candidate.baselineAt) / 60_000)),
        };
      }
      // Поднялось само на следующей же проверке — инцидент не заводим, идём дальше как обычно.
    }

    if (!baseline || baseline.online < NODE_ONLINE_DROP_MIN_BASELINE) return null;
    const dropPct = ((baseline.online - online) / baseline.online) * 100;
    if (dropPct < NODE_ONLINE_DROP_PCT) return null;
    // Не открываем сразу — ждём подтверждения следующим снимком (см. коммент к классу).
    this.pending.set(node.uuid, { baselineOnline: baseline.online, baselineAt: baseline.at, seen: 1 });
    return null;
  }

  private async investigate(
    { node, before, after, minutes }: Drop,
    nodes: RemnawaveNode[],
    /** У скольких ещё нод онлайн упал в этом же проходе (дел по ним ещё нет). */
    sameTick = 0,
  ): Promise<void> {
    const allServers = await this.servers.list();
    // Сервер ноды — по общей связи (адрес, IP, выбор в профиле): раньше сверялись строки, и нода, записанная
    // в Remnawave иначе, чем сервер в панели, разбиралась вслепую — без оплаты, агента и входа.
    const links = await this.links.resolve(allServers, nodes);
    const matched = allServers.find((s) => s.id === links.serverIdsOf(node.uuid)[0]) ?? null;
    // Все записи этой машины — с них ноду не проверяем (и с самого выхода его вход тоже).
    const machine = links.machineIds(node);
    // Сбой не у одного сервера — общая причина вероятнее неоплаты одного из них. Считаем так же, как
    // детекция связи, и раздельно: у скольких других нод упал онлайн (в этом проходе и по свежим делам) и
    // со сколькими серверами пропала связь; своё прежнее дело (под именем ноды или сервера) не считается.
    const fleet = await this.incidentsService
      .fleetTrouble({ serverId: matched?.id ?? null, names: [node.name, matched?.name] })
      .catch(() => ({ nodes: 0, linkedNodes: 0, servers: 0 }));
    const othersDown = sameTick + fleet.nodes;
    // Сервер ноды лежит целиком — онлайн упал поэтому, а не из-за блокировки. Отдельное дело не заводим:
    // пишем в «Сервер недоступен» (или его откроет детекция связи на ближайшем тике).
    let lockedOut: IncidentRow | undefined;
    if (matched) {
      const down = await this.incidents.findOpen(matched.id, 'server_down');
      if (down) {
        // Порт SSH с панели открывается — сервер включён, панель просто не может на него зайти. Падение
        // онлайна тогда не «следствие недоступности»: порт ноды проверяем, итог пишем в это же дело.
        const on = await this.incidentsService.probeHost(matched.host, matched.port).catch(() => false);
        if (!on) {
          await this.incidents.appendEvent(down.id, {
            at: new Date().toISOString(),
            by: 'auto',
            action: `Онлайн ноды «${node.name}» упал с ${before} до ${after} — следствие недоступности сервера, проверку блокировки не запускаю.`,
            result: 'detect',
          });
          return;
        }
        lockedOut = down;
      }
    }
    // Дело о падении онлайна этой ноды уже открыто (заведено до перезапуска панели или онлайн поднялся и
    // снова упал) — второе не заводим: перепроверка раз в минуту и так следит за онлайном в первом.
    const already = (await this.incidents.list('open')).find(
      (i) =>
        baselineFromDetail(i.detail) !== null &&
        (matched ? i.serverId === matched.id : i.serverId === null && i.serverName === node.name),
    );
    if (already) {
      await this.incidents.appendEvent(already.id, {
        at: new Date().toISOString(),
        by: 'auto',
        action: `Онлайн ноды снова резко упал: ${before} → ${after}. Новое дело не завожу — слежу в этом.`,
        result: 'detect',
      });
      return;
    }
    const inbound = await this.remnawave.nodeInbound(node.uuid);
    const result = await this.blockCheck.check(
      node.name,
      node.address,
      inbound?.port ?? null,
      inbound?.sni ?? null,
      machine,
      allServers,
      Boolean(inbound?.failed),
    );
    // У выхода с указанным в профиле входом стучимся и во вход — видно, чья сторона сломалась. Вход указан,
    // а стучаться некуда (у моста нет ноды, мост удалён) — записываем его непроверенным: молчать об этом и
    // писать «другой причины панель не нашла» было бы неправдой.
    const up = await resolveUpstream(matched, allServers, this.remnawave, this.links).catch(
      () => ({ kind: 'none' }) as const,
    );
    if (up.kind === 'target')
      result.entry = await this.blockCheck.checkEntry(up.target, machine, allServers).catch(() => null);
    else if (up.kind === 'unknown') result.entry = unknownEntry(up);
    // Оплата в окне (срок прошёл или наступит в ближайшие сутки) — вероятная причина, если блокировки нет.
    // Ноды нет среди серверов панели — «Биллинг» спросить не о чем: null, про оплату панель не утверждает.
    const payment = matched ? await this.incidentsService.paymentWindowFor(matched.id) : null;
    // Работает ли сам сервер: агент на связи либо порт SSH с панели открывается (агент может молчать или
    // не стоять вовсе). Без второй проверки закрытый порт ноды у работающего сервера объявлялся «Сервер
    // недоступен — вероятнее всего, отключили за неоплату».
    const alive: 'agent' | 'ssh' | false =
      matched?.agentStatus === 'online'
        ? 'agent'
        : matched && (await this.incidentsService.probeHost(matched.host, matched.port).catch(() => false))
          ? 'ssh'
          : false;
    const described = describeAnomaly({
      nodeName: node.name,
      before,
      after,
      windowMin: minutes,
      result,
      portKnown: Boolean(inbound?.port),
      payment,
      // Сервер работает: закрытый порт ноды тогда не «сервер отключили».
      serverAlive: alive,
      othersDown,
      othersLost: fleet.servers,
      unlinked: matched
        ? undefined
        : { address: node.address, namesake: links.namesakeOf(node)?.name ?? null },
    });
    const { title, detail, confirmed } = described;
    if (lockedOut) {
      // Дело «Сервер недоступен» остаётся одно (второе детекция связи всё равно слила бы с ним). В его текст
      // падение онлайна не дописываем: по строке «Онлайн: X →» перепроверка онлайна закрыла бы дело, когда
      // онлайн вернётся, хотя панель на сервер по-прежнему не заходит.
      const verdict = detail.split('\n').find((l) => /^(Похоже|Вывод):/.test(l)) ?? title;
      await this.incidents.appendEvent(lockedOut.id, {
        at: new Date().toISOString(),
        by: 'auto',
        action: `Онлайн ноды «${node.name}» упал с ${before} до ${after}. Сервер включён (порт SSH с панели открывается), поэтому порт ноды проверен. ${verdict}`,
        result: 'detect',
      });
      return;
    }
    // Сервер жив, порт закрыт у самой ноды или файрволом: это не «Сервер недоступен».
    const kind = described.kind === 'server_down' && alive ? 'node_blocked' : described.kind;
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
