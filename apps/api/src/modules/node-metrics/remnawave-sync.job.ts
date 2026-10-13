import { Injectable, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EventsService } from '../events/events.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { NodeMetricsService } from './node-metrics.controller.js';

/** Пока панель открыта, статусы нод сверяются с Remnawave так часто — падение видно через секунды. */
export const LIVE_CHECK_MS = 5_000;

/** Периодическая перепроверка Remnawave (сводка, ноды, сертификат панели), тихо — без записи в Журнал на каждый тик. */
@Injectable()
export class RemnawaveSyncJob {
  private busy = false;
  private lastStartedAt: number | null = null;
  private nextAt = 0;
  private period = 0;
  private liveAt = 0;

  constructor(
    private readonly remnawave: RemnawaveService,
    private readonly settings: MonitoringStore,
    @Optional() private readonly metrics?: NodeMetricsService,
    @Optional() private readonly events?: EventsService,
  ) {}

  @Interval(1_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      const cfg = await this.settings.get();
      if (!cfg.enabled) {
        this.lastStartedAt = null;
        return;
      }
      const now = Date.now();
      const period = cfg.pollSeconds * 1000;
      if (period !== this.period) {
        this.nextAt = this.lastStartedAt === null ? now : this.lastStartedAt + period;
        this.period = period;
      }
      if (this.lastStartedAt !== null && now < this.nextAt) {
        // Между плановыми опросами — лёгкая сверка статусов, только пока кто-то смотрит панель и до опроса не
        // осталось пары секунд.
        if (
          this.events &&
          this.events.viewers() > 0 &&
          now - this.liveAt >= LIVE_CHECK_MS &&
          this.nextAt - now > 2_000
        ) {
          this.liveAt = now;
          await this.remnawave.liveCheck(Math.min(cfg.apiTimeoutSeconds * 1000, 4_000));
        }
        return;
      }
      // Сохраняем фазу расписания при небольшом опоздании таймера.
      this.nextAt =
        this.lastStartedAt === null || now - this.nextAt >= period ? now + period : this.nextAt + period;
      // Считаем интервал от начала, включая неудачный запрос. Не догоняем пропуски пачкой.
      this.lastStartedAt = now;
      await this.remnawave.syncQuiet(cfg.apiTimeoutSeconds * 1000);
      await this.metrics?.collect();
    } finally {
      this.busy = false;
    }
  }
}
