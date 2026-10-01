import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PanelPulse } from '../health/panel-pulse.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { IncidentMetricsService } from './incident-metrics.service.js';
import { IncidentsService } from './incidents.service.js';

/** Тик детекции инцидентов раз в 30 с: свежие метрики из VictoriaMetrics → правила. */
@Injectable()
export class IncidentsJob {
  private readonly log = new Logger(IncidentsJob.name);
  private busy = false;

  constructor(
    private readonly incidents: IncidentsService,
    private readonly metrics: IncidentMetricsService,
    private readonly servers: ServersRepository,
    private readonly pulse: PanelPulse,
  ) {}

  @Interval(30_000)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами — тесты управляют состоянием напрямую (детерминизм).
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  /**
   * Один проход. Удачный ставит отметку живости: по ней /api/health/ready видит, что поиск инцидентов не
   * встал. Упавший или зависший проход отметку не обновляет.
   */
  async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.servers.list();
      if (rows.length > 0) await this.incidents.evaluate(await this.metrics.latest(rows.map((r) => r.id)));
      this.pulse.incidentsTick();
    } catch (err) {
      this.log.warn(`Детекция инцидентов споткнулась: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
