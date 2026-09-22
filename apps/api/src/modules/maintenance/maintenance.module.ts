import { Module } from '@nestjs/common';

import { ServersModule } from '../servers/servers.module.js';
import { AgentReleasesService } from './agent-releases.service.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceRepository } from './maintenance.repository.js';
import { MaintenanceService } from './maintenance.service.js';
import { MaintenanceCheckJob } from './maintenance-check.job.js';

/** R1.8: обслуживание сервера — чек-лист раз в сутки и действия по SSH с живым логом. */
@Module({
  imports: [ServersModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceRepository, MaintenanceService, AgentReleasesService, MaintenanceCheckJob],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
