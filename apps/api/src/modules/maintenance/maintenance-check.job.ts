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

      const agentWork: Array<{
        id: string;
        name: string;
        to: string;
        mode: 'install' | 'repair' | 'update';
      }> = [];
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
        const serviceBroken = check.agent.service !== 'active';
        const outdated = Boolean(
          check.agent.installed &&
            check.agent.latest &&
            compareVersions(check.agent.installed, check.agent.latest) < 0,
        );
        // Суточное обслуживание отвечает и за первоначальную установку/восстановление агента.
        // Раньше сервер без бинарника или с остановленной службой просто пропускался навсегда.
        if (check.agent.latest && (!check.agent.installed || serviceBroken || outdated))
          agentWork.push({
            id: row.id,
            name: row.name,
            to: check.agent.latest,
            mode: !check.agent.installed ? 'install' : serviceBroken ? 'repair' : 'update',
          });
      }

      let updated = 0;
      let stopped: { name: string; error: string } | null = null;
      const repairFailed: Array<{ name: string; error: string }> = [];
      // Раскатку новой версии останавливаем при первой ошибке. Установку отсутствующего агента и
      // восстановление службы продолжаем по остальному парку: эти ошибки относятся к конкретному серверу.
      for (const row of agentWork) {
        const result = await this.maintenance.scheduledAgentUpdate(row.id, row.to).catch((err) => ({
          ok: false,
          error: (err as Error).message,
        }));
        if (!result.ok) {
          const failed = { name: row.name, error: result.error ?? 'неизвестная ошибка' };
          this.log.warn(`Автообслуживание агента ${row.name}: ${failed.error}`);
          // Ошибка установки на одном конкретном сервере (например, недоступен SSH) не должна
          // оставлять без агента все остальные. При ошибке раскатки новой версии серию по-прежнему
          // останавливаем: это может быть проблема самого релиза.
          if (row.mode === 'update') {
            stopped = failed;
            break;
          }
          await this.repo
            .saveCheckError(row.id, `Автоустановка агента не удалась: ${failed.error}`)
            .catch(() => undefined);
          repairFailed.push(failed);
          continue;
        }
        updated += 1;
      }

      if (checked > 0 || deferred > 0)
        await this.notifications.push({
          center: true,
          severity: stopped || repairFailed.length > 0 || checkFailed > 0 || deferred > 0 ? 'warn' : 'ok',
          title: fullSweep
            ? stopped || repairFailed.length > 0 || checkFailed > 0 || deferred > 0
              ? 'Суточное обслуживание требует внимания'
              : 'Суточное обслуживание завершено'
            : checkFailed > 0 || deferred > 0
              ? 'Повтор обслуживания требует внимания'
              : 'Повтор обслуживания завершён',
          body: [
            `Запланировано: ${candidates.length} · проверено: ${checked}${deferred > 0 ? ` · отложено: ${deferred}` : ''}`,
            agentWork.length > 0
              ? `Агент установлен или обновлён: ${updated} из ${agentWork.length}`
              : 'Версии агентов актуальны',
            checkFailed > 0 ? `Не удалось проверить: ${checkFailed}` : null,
            repairFailed.length > 0
              ? `Не удалось установить или восстановить: ${repairFailed.length} (${repairFailed.map((x) => `«${x.name}»`).join(', ')})`
              : null,
            stopped ? `Серия остановлена на «${stopped.name}»: ${stopped.error}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          link: { to: '/servers', label: 'Открыть серверы' },
          ...(fullSweep && (stopped || repairFailed.length > 0 || checkFailed > 0 || deferred > 0)
            ? { telegram: { event: 'maintenance' as const } }
            : {}),
        });
    } finally {
      this.busy = false;
    }
  }
}
