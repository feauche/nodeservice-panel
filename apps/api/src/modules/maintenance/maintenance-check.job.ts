import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  compareVersions,
  MAINTENANCE_CHECK_INTERVAL_HOURS,
  type MaintenanceCheck,
} from '@nodeservice/shared';

import { NotificationsService } from '../notifications/notifications.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { MaintenanceRepository } from './maintenance.repository.js';
import { MaintenanceService } from './maintenance.service.js';

/** Не открываем SSH ко всему парку одновременно, но и не растягиваем проход на часы. */
const CHECK_CONCURRENCY = 3;
/** После временной ошибки повторяем сервер в тот же день, не создавая тревогу каждые пять минут. */
const FAILED_RETRY_MS = 60 * 60_000;

type CheckOutcome = {
  row: { id: string; name: string };
  check: MaintenanceCheck | null | undefined;
};

/**
 * Суточная проверка обслуживания: раз в пять минут проверяем, пора ли запускать общий проход.
 * В суточном проходе участвует весь парк, поэтому времена не расползаются на сутки. Новые серверы
 * и неудачные попытки догоняются отдельно между проходами.
 */
@Injectable()
export class MaintenanceCheckJob {
  private readonly log = new Logger(MaintenanceCheckJob.name);
  private busy = false;

  constructor(
    private readonly servers: ServersRepository,
    private readonly repo: MaintenanceRepository,
    private readonly maintenance: MaintenanceService,
    private readonly notifications: NotificationsService,
  ) {}

  @Interval(5 * 60_000)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами — тесты управляют состоянием напрямую (детерминизм).
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const states = new Map((await this.repo.listStates()).map((s) => [s.serverId, s]));
      const now = Date.now();
      const deadline = now - MAINTENANCE_CHECK_INTERVAL_HOURS * 3_600_000;
      const retryDeadline = now - FAILED_RETRY_MS;
      const lastSweepAt = await this.repo.lastDailySweepAt();
      const fullSweep = !lastSweepAt || lastSweepAt.getTime() <= deadline;
      const allServers = await this.servers.list();
      const candidates = fullSweep
        ? allServers
        : allServers.filter((row) => {
            const state = states.get(row.id);
            if (!state) return true;
            // Между общими проходами догоняем только серверы без результата и прошлые ошибки.
            // updatedAt здесь является временем последней попытки и ограничивает частоту повторов.
            if (!state.check || state.checkError) return state.updatedAt.getTime() <= retryDeadline;
            return false;
          });

      if (candidates.length === 0) return;

      let cursor = 0;
      const outcomes: CheckOutcome[] = new Array(candidates.length);
      const worker = async () => {
        while (cursor < candidates.length) {
          const index = cursor++;
          const row = candidates[index];
          if (!row) return;
          let check: MaintenanceCheck | null | undefined;
          try {
            check = await this.maintenance.scheduledCheck(row.id);
          } catch (err) {
            const message = (err as Error).message;
            this.log.warn(`Проверка обслуживания ${row.name}: ${message}`);
            await this.repo.saveCheckError(row.id, message).catch(() => undefined);
            check = null;
          }
          if (check === undefined)
            await this.repo
              .saveCheckError(row.id, 'Плановая проверка отложена: на сервере уже выполняется обслуживание.')
              .catch(() => undefined);
          outcomes[index] = { row, check };
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(CHECK_CONCURRENCY, candidates.length) }, () => worker()),
      );

      // Отметка ставится после попытки по каждому серверу. Если процесс оборвался посередине,
      // отметки не будет и после перезапуска панель повторит общий проход целиком.
      if (fullSweep) await this.repo.completeDailySweep();

      const outdated: Array<{ id: string; name: string; from: string; to: string }> = [];
      let checked = 0;
      let checkFailed = 0;
      let deferred = 0;
      for (const { row, check } of outcomes) {
        if (check === undefined) {
          deferred += 1;
          continue;
        }
        checked += 1;
        if (!check) {
          checkFailed += 1;
          continue;
        }
        if (
          check.agent.installed &&
          check.agent.latest &&
          compareVersions(check.agent.installed, check.agent.latest) < 0
        )
          outdated.push({ id: row.id, name: row.name, from: check.agent.installed, to: check.agent.latest });
      }

      let updated = 0;
      let stopped: { name: string; error: string } | null = null;
      // Проверяем весь парк до начала обновлений: если один сервер не обновился, остальные устаревшие
      // не попадут в следующую пятиминутку и серия действительно остановится до следующего суточного цикла.
      for (const row of outdated) {
        const result = await this.maintenance.scheduledAgentUpdate(row.id, row.to).catch((err) => ({
          ok: false,
          error: (err as Error).message,
        }));
        if (!result.ok) {
          stopped = { name: row.name, error: result.error ?? 'неизвестная ошибка' };
          this.log.warn(`Автообновление агента ${row.name}: ${stopped.error}`);
          break;
        }
        updated += 1;
      }

      if (checked > 0 || deferred > 0)
        await this.notifications.push({
          center: true,
          severity: stopped || checkFailed > 0 || deferred > 0 ? 'warn' : 'ok',
          title: fullSweep
            ? stopped || checkFailed > 0 || deferred > 0
              ? 'Суточное обслуживание требует внимания'
              : 'Суточное обслуживание завершено'
            : checkFailed > 0 || deferred > 0
              ? 'Повтор обслуживания требует внимания'
              : 'Повтор обслуживания завершён',
          body: [
            `Запланировано: ${candidates.length} · проверено: ${checked}${deferred > 0 ? ` · отложено: ${deferred}` : ''}`,
            outdated.length > 0
              ? `Агент обновлён: ${updated} из ${outdated.length}`
              : 'Версии агентов актуальны',
            checkFailed > 0 ? `Не удалось проверить: ${checkFailed}` : null,
            stopped ? `Серия остановлена на «${stopped.name}»: ${stopped.error}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          link: { to: '/servers', label: 'Открыть серверы' },
          ...(fullSweep && (stopped || checkFailed > 0 || deferred > 0)
            ? { telegram: { event: 'maintenance' as const } }
            : {}),
        });
    } finally {
      this.busy = false;
    }
  }
}
