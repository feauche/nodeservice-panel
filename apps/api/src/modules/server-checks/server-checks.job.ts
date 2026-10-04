import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { BlockCheckResult, ServerCheckRun } from '@nodeservice/shared';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { AutochecksStore } from '../settings/autochecks.store.js';
import { ServerChecksService } from './server-checks.service.js';

const VERDICT_WEIGHT: Record<string, number> = {
  ok: 0,
  partial: 1,
  indeterminate: 1,
  vpn_failed: 2,
  tspu: 2,
  block_16_20: 2,
  ip_block: 2,
  unreachable: 3,
};
const VERDICT_WORD: Record<string, string> = {
  ok: 'доступна',
  partial: 'с перебоями',
  indeterminate: 'REALITY не проверен',
  vpn_failed: 'VPN не проходит',
  tspu: 'признаки ТСПУ',
  block_16_20: 'обрыв данных',
  ip_block: 'блокировка IP',
  unreachable: 'не отвечает',
};

function blockChanges(
  previous: BlockCheckResult | null | undefined,
  current: BlockCheckResult | null | undefined,
) {
  if (!previous || !current) return { direction: 0, lines: [] as string[] };
  const points = (result: BlockCheckResult) => [
    ...[...result.probes, ...result.foreign].map((probe) => [probe.from, probe.verdict] as const),
    ...[...(result.vpnProbes ?? []), ...(result.vpnForeign ?? [])].map(
      (probe) => [`VPN · ${probe.from}`, probe.ok ? 'ok' : 'vpn_failed'] as const,
    ),
  ];
  const before = new Map(points(previous));
  let direction = 0;
  const lines: string[] = [];
  for (const [from, verdict] of points(current)) {
    const old = before.get(from);
    if (!old || old === verdict) continue;
    const delta = (VERDICT_WEIGHT[verdict] ?? 2) - (VERDICT_WEIGHT[old] ?? 2);
    direction += Math.sign(delta);
    lines.push(`${from}: ${VERDICT_WORD[old] ?? old} → ${VERDICT_WORD[verdict] ?? verdict}`);
  }
  return { direction, lines };
}

function compare(previous: ServerCheckRun | undefined, current: ServerCheckRun) {
  if (!previous) return { change: 'первая проверка', direction: 0, lines: [] as string[] };
  if (previous.status !== current.status)
    return {
      change:
        previous.status === 'ok' ? 'стало хуже' : current.status === 'ok' ? 'исправилось' : 'изменилось',
      direction: previous.status === 'ok' ? 1 : current.status === 'ok' ? -1 : 0,
      lines: [] as string[],
    };
  const blocks = blockChanges(previous.blockResult, current.blockResult);
  return {
    change:
      blocks.lines.length === 0
        ? 'без изменений'
        : blocks.direction > 0
          ? 'стало хуже'
          : blocks.direction < 0
            ? 'исправилось'
            : 'изменилось',
    direction: blocks.direction,
    lines: blocks.lines,
  };
}

/**
 * Свои проверки реестра раз в сутки (Настройки → Автопроверки, «Проверки серверов раз в сутки»): раз в
 * 10 минут смотрим, что пора повторить, и идём по одной проверке за раз по всему парку — не нагружаем
 * серверы и сеть параллельными замерами. Процессор сервера с мёртвым SSH пропускаем, но доступность
 * проверяем с других серверов парка: вход на саму цель для неё не нужен. Сторонние скрипты и тяжёлые
 * проверки сами не запускаются никогда — только по кнопке.
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
      const byId = new Map(allServers.map((s) => [s.id, s]));
      const names = new Map(allServers.map((s) => [s.id, s.name]));
      const due = await this.checks.dueLightChecks(allServers.map((s) => s.id));
      const dueChecks = due.filter(
        (item) => item.check === 'russia_access' || byId.get(item.serverId)?.sshOk !== false,
      );
      const sshSkipped = due.filter(
        (item) => item.check !== 'russia_access' && byId.get(item.serverId)?.sshOk === false,
      );
      let ok = 0;
      let failed = 0;
      let skipped = sshSkipped.length;
      let improved = 0;
      let worse = 0;
      const details: string[] = sshSkipped.map(
        (item) =>
          `• ${names.get(item.serverId) ?? item.serverId} · ${item.check === 'cpu' ? 'процессор' : item.check}: пропущено — SSH недоступен`,
      );
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
        const compared = compare(previous, current);
        if (compared.direction < 0) improved += 1;
        if (compared.direction > 0) worse += 1;
        details.push(
          `• ${names.get(due.serverId) ?? due.serverId} · ${current.check === 'russia_access' ? 'доступность' : 'процессор'}: ${current.status === 'ok' ? 'успешно' : 'ошибка'} · ${compared.change}`,
        );
        for (const line of compared.lines) details.push(`  ↳ ${line}`);
      }
      if (ok + failed > 0)
        await this.notifications.push({
          center: true,
          severity: failed > 0 || worse > 0 ? 'warn' : 'ok',
          title: failed > 0 ? 'Автопроверки завершены с ошибками' : 'Автопроверки серверов завершены',
          body: [
            `Запланировано: ${due.length} · успешно: ${ok} · ошибок: ${failed}${skipped > 0 ? ` · пропущено: ${skipped}` : ''}`,
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
