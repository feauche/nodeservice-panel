import { Module } from '@nestjs/common';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { NodeMetricHistoryService } from './node-metric-history.service.js';
import { NodeMetricsController, NodeMetricsService } from './node-metrics.controller.js';
import { RemnawaveSyncJob } from './remnawave-sync.job.js';

/** Метрики владеют расписанием опроса, сохранением и чтением истории. Remnawave — источник. */
@Module({
  imports: [RemnawaveModule, SettingsModule],
  controllers: [NodeMetricsController],
  providers: [NodeMetricsService, NodeMetricHistoryService, RemnawaveSyncJob],
  exports: [NodeMetricsService],
})
export class NodeMetricsModule {}
