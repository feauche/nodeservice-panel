import { Module } from '@nestjs/common';

import { ServersModule } from '../servers/servers.module.js';
import { AgentReleasesService } from './agent-releases.service.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceRepository } from './maintenance.repository.js';
import { MaintenanceService } from './maintenance.service.js';

/** Исторические данные и ручные API обслуживания; автоматические SSH/агентские задачи отключены. */
@Module({
  imports: [ServersModule],
  controllers: [MaintenanceController],
  providers: [MaintenanceRepository, MaintenanceService, AgentReleasesService],
  exports: [MaintenanceService],
})
export class MaintenanceModule {}
