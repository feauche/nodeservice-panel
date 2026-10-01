import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { ServersRepository } from '../servers/servers.repository.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { ServerChecksService } from './server-checks.service.js';

/**
 * Свои проверки реестра раз в сутки (Настройки → Автопроверки, «Проверки серверов раз в сутки»): раз в
 * 10 минут смотрим, что пора повторить, и идём по одной проверке за раз по всему парку — не нагружаем
 * серверы и сеть параллельными замерами. Серверы с заведомо мёртвым SSH пропускаем. Сторонние скрипты
 * и тяжёлые проверки сами не запускаются никогда — только по кнопке.
 */
@Injectable()
export class ServerChecksJob {
  private readonly log = new Logger(ServerChecksJob.name);
  private busy = false;

  constructor(
    private readonly servers: ServersRepository,
    private readonly checks: ServerChecksService,
    private readonly autochecks: AutochecksStore,
  ) {}

  @Interval(10 * 60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await this.autochecks.get()).serverChecksEnabled) return;
      const alive = (await this.servers.list()).filter((s) => s.sshOk !== false);
      const names = new Map(alive.map((s) => [s.id, s.name]));
      for (const due of await this.checks.dueLightChecks(alive.map((s) => s.id))) {
        await this.checks.scheduled(due.serverId, due.check).catch((err) => {
          this.log.warn(`Проверка ${due.check} на ${names.get(due.serverId)}: ${(err as Error).message}`);
        });
      }
    } finally {
      this.busy = false;
    }
  }
}
