import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module.js';
import { SecurityModule } from '../security/security.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { IncidentMetricsService } from './incident-metrics.service.js';
import { IncidentRunnerService } from './incident-runner.service.js';
import { IncidentsController } from './incidents.controller.js';
import { IncidentsJob } from './incidents.job.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';
import { NodeProbeJob } from './node-probe.job.js';

/** R3: инциденты, детекция с гистерезисом, реестр действий T0–T3 с пред-/пост-проверкой и откатом. */
@Module({
  imports: [ServersModule, SettingsModule, MetricsModule, SecurityModule],
  controllers: [IncidentsController],
  providers: [
    IncidentsRepository,
    IncidentsService,
    IncidentsJob,
    NodeProbeJob,
    IncidentMetricsService,
    IncidentRunnerService,
  ],
  exports: [IncidentsService, IncidentRunnerService, IncidentMetricsService],
})
export class IncidentsModule {}
