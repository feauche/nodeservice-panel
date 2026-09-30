import { isIP } from 'node:net';

/** Сколько адресов сервера храним: у машины с десятками сетей хватит первых. */
const ADDRESSES_MAX = 16;

/**
 * Адрес в сравнимом виде: без пробелов, строчными, без квадратных скобок (запись IPv6 в ссылках) и без
 * точки в конце (полная запись домена). «DE1.Example.com.» и «de1.example.com» — один адрес.
 */
export function normalizeAddress(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1')
    .replace(/\.$/, '');
}

/** Адрес, по которому машину видно снаружи: не локальный, не служебный и не из частной сети. */
export function isExternalIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    return !(a === 192 && b === 168);
  }
  if (isIP(ip) === 6) {
    const first = Number.parseInt(ip.split(':')[0] || '0', 16);
    // Только глобальные адреса 2000::/3: ::1, fe80::/10 (локальные) и fc00::/7 (частные) отпадают.
    return first >= 0x2000 && first <= 0x3fff;
  }
  return false;
}

/**
 * Вывод `hostname -I` (или `ip addr`) → внешние адреса сервера. Сети Docker, локальные и частные адреса
 * отбрасываются: они у всех серверов одинаковые, и связывать по ним ноду с сервером нельзя.
 */
export function externalAddresses(raw: string | null): string[] {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(/\s+/)) {
    const ip = normalizeAddress(part);
    if (isExternalIp(ip)) out.add(ip);
    if (out.size >= ADDRESSES_MAX) break;
  }
  return [...out];
}
