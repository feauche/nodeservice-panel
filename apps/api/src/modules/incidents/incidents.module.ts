import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module.js';
import { SecurityModule } from '../security/security.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { IncidentsController } from './incidents.controller.js';
import { IncidentsJob } from './incidents.job.js';
import { IncidentsRepository } from './incidents.repository.js';
import { IncidentsService } from './incidents.service.js';

/** Этап 8: инциденты, детекция правил, автопочинка пресетами. */
@Module({
  imports: [ServersModule, SettingsModule, MetricsModule, SecurityModule],
  controllers: [IncidentsController],
  providers: [IncidentsRepository, IncidentsService, IncidentsJob],
  exports: [IncidentsService],
})
export class IncidentsModule {}
