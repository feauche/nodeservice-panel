import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { HEARTBEAT_EVERY_SECONDS } from '@nodeservice/shared';

import { HeartbeatService } from './heartbeat.service.js';

/** Первый сигнал — вскоре после запуска: к этому времени база и Valkey уже отвечают. */
export const HEARTBEAT_FIRST_DELAY_MS = 20_000;

/** Раз в минуту — сигнал «панель жива» внешнему сервису (см. HeartbeatService). В тестах не тикает. */
@Injectable()
export class HeartbeatJob implements OnApplicationBootstrap {
  constructor(private readonly heartbeat: HeartbeatService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    setTimeout(() => void this.heartbeat.beat(), HEARTBEAT_FIRST_DELAY_MS).unref?.();
  }

  @Interval(HEARTBEAT_EVERY_SECONDS * 1000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.heartbeat.beat();
  }
}
