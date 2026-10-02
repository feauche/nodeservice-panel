import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Server } from '@nodeservice/shared';

import type { Env } from '../../config/env.schema.js';
import { ServersService } from '../servers/servers.service.js';
import { SshService } from '../servers/ssh.service.js';
import {
  buildEgressCommand,
  type EgressReport,
  egressTargets,
  parseEgress,
  pickJump,
} from './egress-check.logic.js';

/** Одна проверка на сервер не чаще раза в 10 минут: это SSH на сервер (иногда через второй). */
const EGRESS_TTL_MS = process.env.NODE_ENV === 'test' ? 0 : 10 * 60_000;

/**
 * «Куда сервер может выйти»: заходит на сам сервер (напрямую или через сервер парка, откуда он доступен)
 * и проверяет подключение к панели, к России и за рубеж. Отвечает на вопрос, который владелец решал
 * руками: сервер жив, файрвол чистый — а что режет его сеть?
 */
@Injectable()
export class EgressCheckService {
  private readonly log = new Logger(EgressCheckService.name);
  private readonly cache = new Map<string, { at: number; value: EgressReport | null }>();
  /** Последний удачный результат по серверу — для окна сервера («Что проверено»), живёт до перезапуска. */
  private readonly last = new Map<string, { at: Date; value: EgressReport }>();

  constructor(
    private readonly servers: ServersService,
    private readonly ssh: SshService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Последний удачный результат для окна сервера. */
  lastFor(serverId: string): { at: Date; value: EgressReport } | null {
    return this.last.get(serverId) ?? null;
  }

  /** Последний результат без новой проверки (для разбора Джарвиса), если он свежий. */
  cached(serverId: string): EgressReport | null {
    const hit = this.cache.get(serverId);
    return hit && Date.now() - hit.at < 10 * 60_000 ? hit.value : null;
  }

  /**
   * `openFrom` — серверы парка, откуда порт SSH открыт: если панель напрямую не пускают, заходим через
   * один из них. null — зайти не удалось ни так, ни так (ничего не выдумываем).
   */
  async check(
    server: Pick<Server, 'id'>,
    all: Server[],
    openFrom: readonly string[] = [],
    opts: { force?: boolean } = {},
  ): Promise<EgressReport | null> {
    const hit = this.cache.get(server.id);
    if (!opts.force && hit && Date.now() - hit.at < EGRESS_TTL_MS) return hit.value;
    const value = await this.run(server, all, openFrom).catch((err) => {
      this.log.warn(`Проверка выхода с сервера ${server.id}: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    this.cache.set(server.id, { at: Date.now(), value });
    if (value && value.results.length > 0) this.last.set(server.id, { at: new Date(), value });
    return value;
  }

  /**
   * Сначала пробуем войти прямо сейчас напрямую. Поле `sshOk` в карточке — результат прошлой проверки:
   * оно могло остаться зелёным, хотя маршрут от панели уже пропал. Если прямой вход не удался, свежая
   * встречная проверка находит серверы парка, с которых порт открыт, и проверка повторяется через один из
   * них. Так кнопка «Выяснить почему» действительно пробует оба пути, которые обещает человеку.
   */
  async checkWithFallback(
    server: Pick<Server, 'id'>,
    all: Server[],
    discoverOpenFrom: () => Promise<readonly string[]>,
    opts: { force?: boolean } = {},
  ): Promise<EgressReport | null> {
    const direct = await this.check(server, all, [], opts);
    if (direct) return direct;
    const openFrom = await discoverOpenFrom().catch(() => []);
    if (openFrom.length === 0) return null;
    // Первая попытка сохранила null в коротком кэше — повтор через ступеньку всегда должен быть свежим.
    return this.check(server, all, openFrom, { force: true });
  }

  private async run(
    server: Pick<Server, 'id'>,
    all: Server[],
    openFrom: readonly string[],
  ): Promise<EgressReport> {
    // Проверяем именно тот маршрут, по которому должен держать WebSocket агент. Интерфейс панели может
    // жить в Польше, а агентский вход — идти через другой reverse proxy или туннель.
    const panelHost = new URL(this.config.get('AGENT_PUBLIC_URL') ?? this.config.get('PUBLIC_URL')).hostname;
    const targets = egressTargets(panelHost, server, all);
    const command = buildEgressCommand(targets, panelHost);
    const { target } = await this.servers.sshTargetFor(server.id);
    const jump = pickJump(
      openFrom,
      all.filter((s) => s.id !== server.id && s.sshOk === true),
    );
    const via = jump ? (await this.servers.sshTargetFor(jump.id)).target : undefined;
    const session = await this.ssh.connect(target, via ? { via } : {});
    try {
      const { stdout } = await session.exec(command);
      const parsed = parseEgress(stdout, targets);
      return { via: jump?.name ?? null, ...parsed };
    } finally {
      session.end();
    }
  }
}
