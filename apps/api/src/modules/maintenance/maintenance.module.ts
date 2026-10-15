import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { ScenariosModule } from '../scenarios/scenarios.module.js';
import { NodeMaintenanceController } from './maintenance.controller.js';
import { NodeMaintenanceService } from './maintenance.service.js';

/** Обслуживание ноды (0.106.0). Запись живёт в RemnawaveModule (её читают все), здесь — включение и окончание. */
@Module({
  imports: [RemnawaveModule, ScenariosModule, IncidentsModule, AuditModule],
  controllers: [NodeMaintenanceController],
  providers: [NodeMaintenanceService],
})
export class NodeMaintenanceModule {}
