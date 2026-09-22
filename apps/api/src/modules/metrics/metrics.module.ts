import { Module } from '@nestjs/common';

import { ServersModule } from '../servers/servers.module.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { VmReaderService } from './vm-reader.service.js';

/** Этап 6: чтение метрик из VictoriaMetrics для «Обзора» и страницы сервера. */
@Module({
  imports: [ServersModule],
  controllers: [MetricsController],
  providers: [MetricsService, VmReaderService],
  exports: [VmReaderService],
})
export class MetricsModule {}
