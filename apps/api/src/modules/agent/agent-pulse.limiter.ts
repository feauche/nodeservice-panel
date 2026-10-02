import { HttpStatus, Injectable } from '@nestjs/common';

import { problem } from '../../common/filters/problem-details.filter.js';
import { throttleIp } from '../auth/throttle.schedule.js';

/** Один адрес допускает до ста агентов с сигналом раз в 10 с; общий предел защищает БД и crypto. */
export const PULSE_PER_ADDRESS_PER_MINUTE = 600;
export const PULSE_TOTAL_PER_MINUTE = 12_000;

/**
 * Короткий предел до чтения сервера из БД. Подпись остаётся основной проверкой доступа, а этот слой не
 * позволяет публичному endpoint тратить неограниченные ресурсы на случайные serverId и подписи.
 */
@Injectable()
export class AgentPulseLimiter {
  private bucket = -1;
  private total = 0;
  private readonly byAddress = new Map<string, number>();

  assertAllowed(ip: string, now = Date.now()): void {
    const bucket = Math.floor(now / 60_000);
    if (bucket !== this.bucket) {
      this.bucket = bucket;
      this.total = 0;
      this.byAddress.clear();
    }
    const key = throttleIp(ip);
    const count = this.byAddress.get(key) ?? 0;
    if (count >= PULSE_PER_ADDRESS_PER_MINUTE || this.total >= PULSE_TOTAL_PER_MINUTE)
      throw problem(HttpStatus.TOO_MANY_REQUESTS, {
        detail: 'Слишком много сигналов агентов. Повтори позже.',
      });
    this.byAddress.set(key, count + 1);
    this.total += 1;
  }
}
