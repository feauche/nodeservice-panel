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
