import { Global, Module } from '@nestjs/common';

import { HealthController } from './health.controller.js';
import { HeartbeatController } from './heartbeat.controller.js';
import { HeartbeatJob } from './heartbeat.job.js';
import { HeartbeatService } from './heartbeat.service.js';
import { PanelAlertsService, PanelAlertsStore } from './panel-alerts.service.js';
import { PanelDiskJob } from './panel-disk.job.js';
import { PanelLifecycleService } from './panel-lifecycle.service.js';
import { PanelPulse } from './panel-pulse.js';
import { PanelReadiness } from './panel-readiness.js';
import { PanelReleaseController } from './panel-release.controller.js';
import { PanelReleaseService } from './panel-release.service.js';

/**
 * Панель следит за собой: живость и готовность (/api/health), отметки фоновых задач, отметки запуска и
 * штатной остановки, оповещения о своих сбоях, сигнал «панель жива» внешнему сервису проверки.
 * Global — отметки и оповещения нужны модулям инцидентов, агента и копий.
 */
@Global()
@Module({
  controllers: [HealthController, PanelReleaseController, HeartbeatController],
  providers: [
    PanelPulse,
    PanelReadiness,
    HeartbeatService,
    HeartbeatJob,
    PanelAlertsStore,
    PanelAlertsService,
    PanelLifecycleService,
    PanelReleaseService,
    PanelDiskJob,
  ],
  exports: [PanelPulse, PanelReadiness, PanelAlertsService, PanelLifecycleService],
})
export class HealthModule {}
