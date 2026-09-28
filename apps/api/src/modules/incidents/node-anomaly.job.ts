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
      for (const node of status.nodes) await this.checkNode(node, status.checkedAt);
    } catch (err) {
      this.log.warn(`Тик аномалии онлайна: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }

  private async checkNode(node: RemnawaveNode, checkedAt: string): Promise<void> {
    const prev = this.lastSample.get(node.uuid);
    const online = node.usersOnline ?? 0;
    // Тот же снимок Remnawave (данные ещё не обновились) — сравнивать пока не с чем, ждём следующего.
    if (prev && prev.checkedAt === checkedAt) return;
    this.lastSample.set(node.uuid, { online, checkedAt });

    const candidate = this.pending.get(node.uuid);
    if (candidate) {
      const stillDown = online < candidate.baselineOnline * (1 - NODE_ONLINE_DROP_PCT / 100);
      if (stillDown && candidate.seen + 1 < NODE_ONLINE_DROP_CONFIRM_CHECKS) {
        // Просадка держится, но проверок подряд ещё мало — ждём следующий снимок.
        candidate.seen += 1;
        return;
      }
      this.pending.delete(node.uuid);
      if (stillDown) {
        const until = this.cooldownUntil.get(node.uuid) ?? 0;
        if (Date.now() >= until) {
          this.cooldownUntil.set(node.uuid, Date.now() + COOLDOWN_MIN * 60_000);
          await this.investigate(node, candidate.baselineOnline, online).catch((err) =>
            this.log.warn(
              `Проверка блокировки ноды «${node.name}»: ${err instanceof Error ? err.message : err}`,
            ),
          );
        }
        return;
      }
      // Поднялось само на следующей же проверке — инцидент не заводим, идём дальше как обычно.
    }

    if (!prev || prev.online < NODE_ONLINE_DROP_MIN_BASELINE) return;
    const dropPct = ((prev.online - online) / prev.online) * 100;
    if (dropPct < NODE_ONLINE_DROP_PCT) return;
    // Не открываем сразу — ждём подтверждения следующим снимком (см. коммент к классу).
    this.pending.set(node.uuid, { baselineOnline: prev.online, seen: 1 });
  }

  private async investigate(node: RemnawaveNode, before: number, after: number): Promise<void> {
    const allServers = await this.servers.list();
    const matched = allServers.find((s) => s.host === node.address) ?? null;
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
    const { title, detail, confirmed } = describeAnomaly({
      nodeName: node.name,
      before,
      after,
      windowMin: NODE_ONLINE_DROP_WINDOW_MIN,
      result,
      portKnown: Boolean(inbound?.port),
    });
    const row = await this.incidents.open({
      serverId: matched?.id ?? null,
      serverName: matched?.name ?? node.name,
      kind: 'node_blocked',
      severity: confirmed ? 'crit' : 'warn',
      title,
      detail,
      timeline: [{ at: new Date().toISOString(), by: 'auto', action: 'Обнаружено', result: 'detect' }],
    });
    // Раньше такой инцидент писался только в базу: ни колокольчика, ни Telegram. Сообщаем как обычный.
    if (row)
      await this.notifications.push({
        severity: confirmed ? 'crit' : 'warn',
        title,
        body: detail,
        // Сервер привязываем, только если нода есть в NodeService: у уведомления ссылка на запись сервера.
        server: matched ? { id: matched.id, name: matched.name, host: node.address } : null,
        link: { to: `/incidents/${row.id}`, label: 'Открыть инцидент' },
        telegram: {
          event: confirmed ? 'incident_crit' : 'incident_warn',
          incidentId: row.id,
          kind: 'node_blocked',
          serverKey: matched?.id ?? `node:${node.uuid}`,
          server: { name: matched?.name ?? node.name, host: node.address },
        },
      });
  }
}
