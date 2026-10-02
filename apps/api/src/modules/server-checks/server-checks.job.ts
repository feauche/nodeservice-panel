import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { NotificationsService } from '../notifications/notifications.service.js';
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
    private readonly notifications: NotificationsService,
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
      const allServers = await this.servers.list();
      const alive = allServers.filter((s) => s.sshOk !== false);
      const names = new Map(alive.map((s) => [s.id, s.name]));
      const dueChecks = await this.checks.dueLightChecks(alive.map((s) => s.id));
      let ok = 0;
      let failed = 0;
      let skipped = 0;
      let improved = 0;
      let worse = 0;
      const details: string[] = [];
      for (const due of dueChecks) {
        const previous = (await this.checks.history(due.serverId, due.check, 1).catch(() => []))[0];
        let launchFailed = false;
        const current = await this.checks.scheduled(due.serverId, due.check).catch((err) => {
          launchFailed = true;
          this.log.warn(`Проверка ${due.check} на ${names.get(due.serverId)}: ${(err as Error).message}`);
          return null;
        });
        if (!current) {
          if (launchFailed) {
            failed += 1;
            details.push(`• ${names.get(due.serverId) ?? due.serverId}: ошибка запуска`);
          } else {
            skipped += 1;
            details.push(
              `• ${names.get(due.serverId) ?? due.serverId}: пропущено — уже идёт другая проверка`,
            );
          }
          continue;
        }
        if (current.status === 'ok') ok += 1;
        else failed += 1;
        if (previous && previous.status !== 'ok' && current.status === 'ok') improved += 1;
        if (previous?.status === 'ok' && current.status !== 'ok') worse += 1;
        const change = !previous
          ? 'первая проверка'
          : previous.status === current.status
            ? 'без изменений'
            : previous.status === 'ok'
              ? 'стало хуже'
              : 'исправилось';
        details.push(
          `• ${names.get(due.serverId) ?? due.serverId}: ${current.status === 'ok' ? 'успешно' : 'ошибка'} · ${change}`,
        );
      }
      if (dueChecks.length > 0)
        for (const server of allServers.filter((s) => s.sshOk === false))
          details.push(`• ${server.name}: пропущено — SSH недоступен`);
      if (ok + failed > 0)
        await this.notifications.push({
          center: true,
          severity: failed > 0 || worse > 0 ? 'warn' : 'ok',
          title: failed > 0 ? 'Автопроверки завершены с ошибками' : 'Автопроверки серверов завершены',
          body: [
            `Запланировано: ${dueChecks.length} · успешно: ${ok} · ошибок: ${failed}${skipped > 0 ? ` · занято: ${skipped}` : ''}`,
            improved > 0 || worse > 0
              ? `По сравнению с прошлым запуском: лучше — ${improved}, хуже — ${worse}`
              : 'Состояние относительно прошлого запуска не ухудшилось',
            '',
            'По серверам:',
            ...details,
          ].join('\n'),
          link: { to: '/servers', label: 'Открыть серверы' },
        });
    } finally {
      this.busy = false;
    }
  }
}
