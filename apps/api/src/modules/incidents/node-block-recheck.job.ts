import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { NODE_ONLINE_DROP_MIN_BASELINE } from '@nodeservice/shared';

import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { ServersService } from '../servers/servers.service.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';
import { NodeBlockCheckService } from './node-block-check.service.js';

const TICK_MS = 60_000;
/** Тяжёлая проверка (реальные SSH-подключения с нескольких серверов парка) — не чаще, чем раз во
 * столько на один инцидент, даже если тиков было несколько. */
const MIN_GAP_MS = 2 * 60_000;

/**
 * Пока открыт «Похоже на блокировку» (node_blocked), панель сама не проверяла, не прошло ли само:
 * решение всегда считалось ручным. На практике часть таких инцидентов — обычная перезагрузка сервера,
 * онлайн ненадолго падает до нуля и сам возвращается; висеть открытым такой инцидент не должен
 * (решение владельца 28.09.2026). Эта джоба, пока инцидент открыт, смотрит: если онлайн ноды снова
 * похож на нормальный, повторяет ТУ ЖЕ проверку блокировки, что его открыла, — и если она теперь тоже
 * говорит «проблем нет», закрывает инцидент сама, как «поднялось само». Если проверка снова находит
 * проблему — ничего не делает: раз похоже, что блокировка настоящая, закрывать её должен человек.
 */
@Injectable()
export class NodeBlockRecheckJob {
  private readonly log = new Logger(NodeBlockRecheckJob.name);
  private readonly lastCheckedAt = new Map<string, number>();
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

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const open = (await this.incidentsRepo.list('open')).filter((i) => i.kind === 'node_blocked');
      if (open.length === 0) return;
      const status = await this.remnawave.status();
      if (!status.connected) return;
      const allServers = await this.servers.list();
      for (const row of open) {
        const now = Date.now();
        const last = this.lastCheckedAt.get(row.id) ?? 0;
        if (now - last < MIN_GAP_MS) continue;
        // Заголовок/detail не хранят uuid ноды: у сопоставленной с сервером панели ищем ноду по адресу
        // сервера (так же, как при открытии), у несопоставленной — по имени ноды (serverName = node.name).
        const server = row.serverId ? (allServers.find((s) => s.id === row.serverId) ?? null) : null;
        const node = server
          ? status.nodes.find((n) => n.address === server.host)
          : status.nodes.find((n) => n.name === row.serverName);
        if (!node) continue;
        const online = node.usersOnline ?? 0;
        // Дешёвая проверка сначала: пока онлайн ещё не похож на нормальный, тяжёлую проверку не гоняем.
        if (online < NODE_ONLINE_DROP_MIN_BASELINE) continue;
        this.lastCheckedAt.set(row.id, now);
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
        if (result && result.probes.length > 0 && result.verdict === 'ok') {
          await this.incidents.autoResolveById(
            row.id,
            `Повторная проверка снова не нашла проблем: онлайн ноды в норме (${online}), порт открыт. Похоже, была короткая просадка — например, перезапуск сервера.`,
          );
          this.lastCheckedAt.delete(row.id);
        }
      }
    } catch (err) {
      this.log.warn(`Тик перепроверки блокировки ноды: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.busy = false;
    }
  }
}
