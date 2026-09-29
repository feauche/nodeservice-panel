import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { FleetStatsController } from './fleet-stats.controller.js';
import { FleetStatsService } from './fleet-stats.service.js';

/** Статистика парка за период: только чтение метрик, инцидентов и оплат. */
@Module({
  imports: [MetricsModule, RemnawaveModule],
  controllers: [FleetStatsController],
  providers: [FleetStatsService],
  exports: [FleetStatsService],
})
export class FleetStatsModule {}
