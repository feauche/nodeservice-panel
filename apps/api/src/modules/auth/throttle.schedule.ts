import { THROTTLE_FREE_ATTEMPTS, THROTTLE_SCHEDULE_SECONDS } from '@nodeservice/shared';

/**
 * Чистая арифметика троттлинга (без Valkey) — для юнит-тестов.
 * series — порядковый номер серии из THROTTLE_FREE_ATTEMPTS неудач (1, 2, 3…).
 */
export function blockSecondsForSeries(series: number): number {
  const idx = Math.min(Math.max(series, 1) - 1, THROTTLE_SCHEDULE_SECONDS.length - 1);
  return THROTTLE_SCHEDULE_SECONDS[idx] ?? THROTTLE_SCHEDULE_SECONDS[0];
}

/** Достигнут ли порог, после которого начинается пауза. */
export function shouldBlock(consecutiveFailures: number): boolean {
  return consecutiveFailures >= THROTTLE_FREE_ATTEMPTS;
}

/** Секунды до снятия паузы из ms; минимум 1, чтобы Retry-After не был нулём. */
export function retryAfterSeconds(msBeforeNext: number): number {
  return Math.max(1, Math.ceil(msBeforeNext / 1000));
}
