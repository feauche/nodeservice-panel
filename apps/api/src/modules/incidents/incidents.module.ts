import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { NodeMetricsModule } from '../node-metrics/node-metrics.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { SecurityModule } from '../security/security.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { CheckHostModule } from './check-host.module.js';
import { FleetMonitorJob } from './fleet-monitor.job.js';
import { IncidentReminderJob } from './incident-reminder.job.js';
import { IncidentRunnerService } from './incident-runner.service.js';
import { IncidentsController } from './incidents.controller.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';
import { WaveService } from './wave.service.js';

/** События нод: мониторинг Remnawave с подтверждением, напоминания, ручное закрытие. */
@Module({
  imports: [
    CheckHostModule,
    SettingsModule,
    SecurityModule,
    RemnawaveModule,
    BillingModule,
    NodeMetricsModule,
  ],
  controllers: [IncidentsController],
  providers: [
    FleetMonitorJob,
    IncidentsRepository,
    IncidentsService,
    IncidentRunnerService,
    IncidentReminderJob,
    WaveService,
  ],
  exports: [IncidentsService, IncidentRunnerService, WaveService],
})
export class IncidentsModule {}
