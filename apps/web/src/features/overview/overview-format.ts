/** Байты/с → Мбит/с одной цифрой после запятой; null — данных нет. */
export function formatMbps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return '—';
  return ((bps * 8) / 1_000_000).toFixed(1);
}

/** Процент без дробей; null — тире. */
export function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return '—';
  return String(Math.round(v));
}

/** Среднее по ненулевым значениям; null, если данных нет ни у кого. */
export function avg(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

/** Сумма по ненулевым; null, если данных нет ни у кого. */
export function sum(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

/** Авто-масштаб трафика из байт/с: «2.04 Гбит/с» / «18.4 Мбит/с» / «640 Кбит/с». */
export function formatTraffic(bytesPerSec: number | null): { value: string; unit: string } {
  if (bytesPerSec === null) return { value: '—', unit: '' };
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return { value: (bits / 1e9).toFixed(2), unit: 'Гбит/с' };
  // Как на карточках серверов: от 10 Мбит/с дробная часть только мешает.
  if (bits >= 1e7) return { value: Math.round(bits / 1e6).toString(), unit: 'Мбит/с' };
  if (bits >= 1e6) return { value: (bits / 1e6).toFixed(1), unit: 'Мбит/с' };
  return { value: Math.round(bits / 1e3).toString(), unit: 'Кбит/с' };
}
