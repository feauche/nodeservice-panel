import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  BLOCK_VERDICT_LABELS,
  type BlockVerdict,
  NODE_ONLINE_DROP_MIN_BASELINE,
  NODE_ONLINE_RECOVER_CHECKS,
  NODE_ONLINE_RECOVER_PCT,
} from '@nodeservice/shared';

import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersService } from '../servers/servers.service.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';
import { NodeBlockCheckService } from './node-block-check.service.js';

const TICK_MS = 60_000;
/** Тяжёлая проверка (SSH-подключения с нескольких серверов парка) — не чаще, чем раз во столько на инцидент. */
const MIN_GAP_MS = 2 * 60_000;
/** Вердикты, при которых закрывать нельзя, даже если онлайн вернулся: похоже на настоящую блокировку. */
const BLOCKING: ReadonlySet<BlockVerdict> = new Set(['tspu', 'block_16_20', 'ip_block']);

interface Watch {
  /** Последний учтённый снимок Remnawave — один снимок считаем одной проверкой. */
  checkedAt: string | null;
  /** Сколько проверок подряд онлайн в норме. */
  up: number;
  /** Что уже записано в хронологию: чтобы не писать каждую минуту одно и то же. */
  said: 'watching' | 'up' | 'down' | 'blocked' | null;
  probedAt: number;
}

/** Онлайн до падения из текста дела: «Онлайн: 396 → 0 (−100 %) …». */
export function baselineFromDetail(detail: string): number | null {
  const m = /Онлайн:\s*(\d+)\s*→/.exec(detail);
  return m ? Number(m[1]) : null;
}

/** Порог «онлайн снова в норме»: половина прежнего, но не меньше минимальной базы. */
export function recoverThreshold(baseline: number | null): number {
  if (!baseline) return NODE_ONLINE_DROP_MIN_BASELINE;
  return Math.max(NODE_ONLINE_DROP_MIN_BASELINE, Math.ceil((baseline * NODE_ONLINE_RECOVER_PCT) / 100));
}

/**
 * Пока открыт инцидент падения онлайна (node_blocked), панель следит за онлайном ноды на каждом снимке
 * Remnawave (раз в минуту) — нода может и не быть сервером NodeService, онлайн берётся из Remnawave.
 * Решение владельца 29.09.2026: онлайн три проверки подряд в норме (не меньше половины прежнего) —
 * значит, всё работает, инцидент кратковременный, закрываем сам. Перед закрытием один раз повторяем
 * проверку порта с серверов парка: если она видит признаки блокировки (ТСПУ, «16–20 КБ», IP из России),
 * оставляем открытым — это решает человек. Каждое изменение (вернулся, снова упал, ждём) пишется в
 * хронологию, чтобы было видно, что панель следит.
 */
@Injectable()
export class NodeBlockRecheckJob {
  private readonly log = new Logger(NodeBlockRecheckJob.name);
  private readonly watch = new Map<string, Watch>();
  private busy = false;

  constructor(
    private readonly incidentsRepo: IncidentsRepository,
    private readonly incidents: IncidentsService,
    private readonly remnawave: RemnawaveService,
    private readonly servers: ServersService,
    private readonly blockCheck: NodeBlockCheckService,
  ) {}

  @Interval(TICK_MS)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  private async note(id: string, action: string): Promise<void> {
    await this.incidentsRepo.appendEvent(id, {
      at: new Date().toISOString(),
      by: 'auto',
      action,
      result: 'notify',
    });
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // «Сервер недоступен» от проверки онлайна (у сервера без агента) тоже закрывается возвратом онлайна.
      const open = (await this.incidentsRepo.list('open')).filter(
        (i) =>
          // Только дела падения онлайна («Онлайн: X →»): «Недоступен из части сетей» закрывает детекция связи.
          (i.kind === 'node_blocked' || i.kind === 'server_down') && baselineFromDetail(i.detail) !== null,
      );
      for (const id of this.watch.keys()) if (!open.some((r) => r.id === id)) this.watch.delete(id);
      if (open.length === 0) return;
      const status = await this.remnawave.status();
      if (!status.connected || !status.checkedAt) return;
      const allServers = await this.servers.list();
      for (const row of open) {
        const w = this.watch.get(row.id) ?? { checkedAt: null, up: 0, said: null, probedAt: 0 };
        this.watch.set(row.id, w);
        // Тот же снимок, что в прошлый раз, — новой проверки ещё не было.
        if (w.checkedAt === status.checkedAt) continue;
        w.checkedAt = status.checkedAt;
        // У сопоставленной с сервером ноды ищем по адресу, у несопоставленной — по имени ноды.
        const server = row.serverId ? (allServers.find((s) => s.id === row.serverId) ?? null) : null;
        const node =
          (server ? status.nodes.find((n) => n.address === server.host) : undefined) ??
          status.nodes.find((n) => n.name === row.serverName);
        if (!node) continue;
        const online = node.usersOnline ?? 0;
        const baseline = baselineFromDetail(row.detail);
        const need = recoverThreshold(baseline);
        const was = baseline ? ` (до падения ${baseline})` : '';

        if (online < need) {
          if (w.said === 'up')
            await this.note(row.id, `Онлайн снова упал: ${online}${was}. Продолжаю следить каждую минуту.`);
          else if (w.said === null)
            await this.note(
              row.id,
              `Слежу за онлайном ноды каждую минуту: сейчас ${online}${was}. Закрою сам, если онлайн ${NODE_ONLINE_RECOVER_CHECKS} проверки подряд будет не ниже ${need}.`,
            );
          w.up = 0;
          if (w.said !== 'blocked') w.said = w.said === null ? 'watching' : 'down';
          continue;
        }

        w.up += 1;
        if (w.said !== 'up' && w.said !== 'blocked') {
          w.said = 'up';
          if (w.up < NODE_ONLINE_RECOVER_CHECKS)
            await this.note(
              row.id,
              `Онлайн вернулся: ${online}${was}. Если продержится ещё ${NODE_ONLINE_RECOVER_CHECKS - w.up} ${NODE_ONLINE_RECOVER_CHECKS - w.up === 1 ? 'проверку' : 'проверки'}, закрою инцидент сам.`,
            );
        }
        if (w.up < NODE_ONLINE_RECOVER_CHECKS) continue;
        if (Date.now() - w.probedAt < MIN_GAP_MS) continue;
        w.probedAt = Date.now();

        // Онлайн в норме нужное число проверок — один раз стучимся в порт тем же способом, что при открытии.
        const inbound = await this.remnawave.nodeInbound(node.uuid);
        const result = await this.blockCheck
          .check(
            node.name,
            node.address,
            inbound?.port ?? null,
            inbound?.sni ?? null,
            server?.id ?? null,
            allServers,
          )
          .catch((err) => {
            this.log.warn(
              `Перепроверка блокировки «${node.name}»: ${err instanceof Error ? err.message : err}`,
            );
            return null;
          });
        if (result && result.probes.length > 0 && BLOCKING.has(result.verdict)) {
          if (w.said !== 'blocked') {
            w.said = 'blocked';
            await this.note(
              row.id,
              `Онлайн в норме (${online}), но проверка порта по-прежнему показывает: ${BLOCK_VERDICT_LABELS[result.verdict].toLowerCase()}. Оставляю открытым — решите сами.`,
            );
          }
          continue;
        }
        const probe =
          !result || result.probes.length === 0
            ? 'Порт с серверов парка проверить не удалось, ориентируюсь на онлайн.'
            : result.verdict === 'ok'
              ? 'Порт открыт.'
              : 'Порт с серверов парка не ответил, но пользователи подключаются — ориентируюсь на онлайн.';
        await this.incidents.autoResolveById(
          row.id,
          `Онлайн ${NODE_ONLINE_RECOVER_CHECKS} проверки подряд в норме: ${online}${was}. ${probe} Похоже, была короткая просадка — например, перезапуск сервера или сбой у хостера.`,
        );
        this.watch.delete(row.id);
      }
    } catch (err) {
      this.log.warn(`Тик перепроверки блокировки ноды: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }
}
