import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { errorText } from '../../common/filters/problem-details.filter.js';
import { CapacityService } from './capacity.service.js';

/** Раз в час: сетевые карты, которые давно не смотрели, и пересчёт ёмкости (ответ страницы — из памяти). */
@Injectable()
export class CapacityJob {
  private readonly log = new Logger(CapacityJob.name);
  private running = false;

  constructor(private readonly capacity: CapacityService) {}

  @Interval(3_600_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test' || this.running) return;
    this.running = true;
    try {
      await this.capacity.probeStaleLinks();
      await this.capacity.recompute();
    } catch (err) {
      this.log.warn(`Ёмкость не посчиталась: ${errorText(err)}`);
    } finally {
      this.running = false;
    }
  }
}
