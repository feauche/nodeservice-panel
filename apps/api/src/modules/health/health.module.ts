import { Global, Module } from '@nestjs/common';

import { StepUpGuard } from '../security/step-up.guard.js';
import { ServersModule } from '../servers/servers.module.js';
import { HealthController } from './health.controller.js';
import { PanelAlertsService, PanelAlertsStore } from './panel-alerts.service.js';
import { PanelDiskJob } from './panel-disk.job.js';
import { PanelLifecycleService } from './panel-lifecycle.service.js';
import { PanelPulse } from './panel-pulse.js';
import { WatchdogController } from './watchdog.controller.js';
import { WatchdogService } from './watchdog.service.js';

/**
 * Панель следит за собой: живость и готовность (/api/health), отметки фоновых задач, отметки запуска и
 * штатной остановки, оповещения о своих сбоях и сторож на сервере парка — на случай, когда панель лежит
 * целиком. Global — отметки и оповещения нужны модулям инцидентов, агента и копий.
 */
@Global()
@Module({
  imports: [ServersModule],
  controllers: [HealthController, WatchdogController],
  providers: [
    PanelPulse,
    PanelAlertsStore,
    PanelAlertsService,
    PanelLifecycleService,
    PanelDiskJob,
    WatchdogService,
    StepUpGuard,
  ],
  exports: [PanelPulse, PanelAlertsService, PanelLifecycleService],
})
export class HealthModule {}
