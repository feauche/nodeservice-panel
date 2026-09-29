import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { CapacityController } from './capacity.controller.js';
import { CapacityJob } from './capacity.job.js';
import { CapacityService } from './capacity.service.js';

/** Ёмкость парка: сколько ещё людей выдержат ноды и во что упрутся; канал сервера. */
@Module({
  imports: [MetricsModule, RemnawaveModule, ServersModule],
  controllers: [CapacityController],
  providers: [CapacityService, CapacityJob],
  exports: [CapacityService],
})
export class CapacityModule {}
