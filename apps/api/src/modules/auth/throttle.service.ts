import { Inject, Injectable } from '@nestjs/common';
import { THROTTLE_FREE_ATTEMPTS } from '@nodeservice/shared';
import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { authProblems } from './auth.problems.js';
import { blockSecondsForSeries, retryAfterSeconds, shouldBlock } from './throttle.schedule.js';

/** Окно, в котором копятся неудачи одной серии. */
const FAILURE_WINDOW_SECONDS = 15 * 60;
/** Память о номере серии: час тишины (или длина паузы, если она дольше) — и расписание начинается заново. */
export const SERIES_MEMORY_SECONDS = 60 * 60;

export interface ThrottleKey {
  ip: string;
  login: string;
}

/**
 * Счётчики неудач подряд по IP и по логину. После THROTTLE_FREE_ATTEMPTS — пауза по
 * расписанию THROTTLE_SCHEDULE_SECONDS, растущая с каждой серией; успех всё сбрасывает.
 */
@Injectable()
export class ThrottleService {
  private readonly byIp: RateLimiterRedis;
  private readonly byLogin: RateLimiterRedis;

  constructor(@Inject(VALKEY) private readonly valkey: Redis) {
    const common = { storeClient: valkey, points: THROTTLE_FREE_ATTEMPTS, duration: FAILURE_WINDOW_SECONDS };
    this.byIp = new RateLimiterRedis({ ...common, keyPrefix: 'throttle:ip' });
    this.byLogin = new RateLimiterRedis({ ...common, keyPrefix: 'throttle:login' });
  }

  /** Бросает 429, если IP или логин сейчас на паузе. */
  async assertAllowed(key: ThrottleKey): Promise<void> {
    const wait = Math.max(
      blockedMs(await this.byIp.get(key.ip)),
      blockedMs(await this.byLogin.get(normalize(key.login))),
    );
    if (wait > 0) throw authProblems.throttled(retryAfterSeconds(wait));
  }

  /** Регистрирует неудачу; если достигнут порог — включает паузу и бросает 429. */
  async recordFailure(key: ThrottleKey): Promise<void> {
    const login = normalize(key.login);
    const [ipRes, loginRes] = await Promise.all([
      safeConsume(this.byIp, key.ip),
      safeConsume(this.byLogin, login),
    ]);
    let wait = 0;
    if (shouldBlock(ipRes.consumedPoints)) wait = Math.max(wait, await this.block(this.byIp, key.ip));
    if (shouldBlock(loginRes.consumedPoints)) wait = Math.max(wait, await this.block(this.byLogin, login));
    if (wait > 0) throw authProblems.throttled(retryAfterSeconds(wait));
  }

  /** Успешный вход: сбрасываем счётчики и память о сериях для обоих ключей. */
  async reset(key: ThrottleKey): Promise<void> {
    const login = normalize(key.login);
    await Promise.all([
      this.byIp.delete(key.ip),
      this.byLogin.delete(login),
      this.valkey.del(seriesKey('ip', key.ip), seriesKey('login', login)),
    ]);
  }

  /** Сколько секунд блокировки получит следующая серия (для тестов/диагностики). */
  async currentSeries(kind: 'ip' | 'login', value: string): Promise<number> {
    const raw = await this.valkey.get(seriesKey(kind, kind === 'login' ? normalize(value) : value));
    return raw ? Number(raw) : 0;
  }

  private async block(limiter: RateLimiterRedis, value: string): Promise<number> {
    const kind = limiter === this.byIp ? 'ip' : 'login';
    const key = seriesKey(kind, value);
    const series = await this.valkey.incr(key);
    const seconds = blockSecondsForSeries(series);
    await this.valkey.expire(key, Math.max(seconds, SERIES_MEMORY_SECONDS));
    await limiter.block(value, seconds);
    return seconds * 1000;
  }
}

function normalize(login: string): string {
  return login.trim().toLowerCase();
}

function seriesKey(kind: 'ip' | 'login', value: string): string {
  return `throttle:series:${kind}:${value}`;
}

/** rate-limiter-flexible бросает RateLimiterRes при исчерпании очков — нам это не ошибка. */
async function safeConsume(limiter: RateLimiterRedis, key: string): Promise<RateLimiterRes> {
  try {
    return await limiter.consume(key, 1);
  } catch (err) {
    if (err instanceof RateLimiterRes) return err;
    throw err;
  }
}

/** Ключ на паузе, если очки исчерпаны и до сброса ещё есть время. */
function blockedMs(res: RateLimiterRes | null): number {
  if (!res) return 0;
  return res.consumedPoints > THROTTLE_FREE_ATTEMPTS && res.msBeforeNext > 0 ? res.msBeforeNext : 0;
}
