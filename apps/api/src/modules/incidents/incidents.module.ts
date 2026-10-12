import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { SecurityModule } from '../security/security.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { CheckHostModule } from './check-host.module.js';
import { EgressController } from './egress.controller.js';
import { EgressCheckService } from './egress-check.service.js';
import { FleetMonitorJob } from './fleet-monitor.job.js';
import { IncidentMetricsService } from './incident-metrics.service.js';
import { IncidentReminderJob } from './incident-reminder.job.js';
import { IncidentRunnerService } from './incident-runner.service.js';
import { IncidentsController } from './incidents.controller.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';
import { NodeBlockCheckService } from './node-block-check.service.js';

/** R3: инциденты, детекция с гистерезисом, реестр действий T0–T3 с пред-/пост-проверкой и откатом. */
@Module({
  imports: [
    CheckHostModule,
    AgentModule,
    ServersModule,
    SettingsModule,
    MetricsModule,
    SecurityModule,
    MaintenanceModule,
    RemnawaveModule,
    BillingModule,
  ],
  controllers: [IncidentsController, EgressController],
  providers: [
    FleetMonitorJob,
    IncidentsRepository,
    IncidentsService,
    IncidentMetricsService,
    IncidentRunnerService,
    NodeBlockCheckService,
    EgressCheckService,
    IncidentReminderJob,
  ],
  exports: [
    IncidentsService,
    IncidentRunnerService,
    IncidentMetricsService,
    NodeBlockCheckService,
    EgressCheckService,
  ],
})
export class IncidentsModule {}
