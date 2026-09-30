import { isIPv4, isIPv6 } from 'node:net';
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

/**
 * Ключ счёта попыток по адресу. IPv4 — адрес целиком. IPv6 — сеть /64: её выдают клиенту целиком,
 * и он может менять адрес внутри неё на каждом запросе, так что счёт по полному адресу паузы не даёт.
 * «::ffff:1.2.3.4» — тот же IPv4. Не адрес — возвращается как есть: счёт всё равно ведётся.
 */
export function throttleIp(ip: string): string {
  // Зона интерфейса (fe80::1%eth0) к адресу не относится.
  const raw = ip.trim().toLowerCase().replace(/%.*$/, '');
  if (isIPv4(raw) || !isIPv6(raw)) return raw;
  const groups = expandIpv6(raw);
  if (!groups) return raw;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`;
  return `${[g0, g1, g2, g3].map((g) => g.toString(16)).join(':')}::/64`;
}

/**
 * Восемь групп адреса IPv6 числами. Раскрывает «::» и хвост в виде IPv4: без этого один и тот же адрес
 * в сжатой записи дал бы другой ключ. null — разобрать не удалось.
 */
function expandIpv6(ip: string): number[] | null {
  let text = ip;
  const lastColon = text.lastIndexOf(':');
  const last = text.slice(lastColon + 1);
  if (last.includes('.')) {
    const [a = -1, b = -1, c = -1, d = -1, ...extra] = last.split('.').map(Number);
    if (extra.length > 0 || [a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const zeros = tail === undefined ? 0 : 8 - left.length - right.length;
  if (zeros < 0 || left.length + right.length + zeros !== 8) return null;
  const groups = [...left, ...Array<string>(zeros).fill('0'), ...right].map((g) => Number.parseInt(g, 16));
  return groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff) ? null : groups;
}
