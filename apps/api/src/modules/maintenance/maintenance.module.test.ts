import { Module } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { ServersModule } from '../servers/servers.module.js';
import { AgentReleasesService } from './agent-releases.service.js';
import { MaintenanceController } from './maintenance.controller.js';
import { MaintenanceModule } from './maintenance.module.js';
import { MaintenanceRepository } from './maintenance.repository.js';
import { MaintenanceService } from './maintenance.service.js';

@Module({})
class HistoricalServersTestModule {}

describe('MaintenanceModule retirement', () => {
  it('keeps historical/manual APIs without registering automatic SSH or agent jobs', async () => {
    const maintenance = {
      scheduledCheck: vi.fn(),
      scheduledAgentUpdate: vi.fn(),
    };
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot(), MaintenanceModule],
    })
      .overrideModule(ServersModule)
      .useModule(HistoricalServersTestModule)
      .overrideProvider(MaintenanceRepository)
      .useValue({})
      .overrideProvider(MaintenanceService)
      .useValue(maintenance)
      .overrideProvider(AgentReleasesService)
      .useValue({})
      .compile();

    try {
      await module.init();
      expect(module.get(MaintenanceController)).toBeInstanceOf(MaintenanceController);
      expect(module.get(MaintenanceService)).toBe(maintenance);
      expect(module.get(SchedulerRegistry).getIntervals()).toEqual([]);
      expect(module.get(SchedulerRegistry).getCronJobs().size).toBe(0);
      expect(maintenance.scheduledCheck).not.toHaveBeenCalled();
      expect(maintenance.scheduledAgentUpdate).not.toHaveBeenCalled();
      expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, MaintenanceModule)).toContain(MaintenanceService);
    } finally {
      await module.close();
    }
  });
});
