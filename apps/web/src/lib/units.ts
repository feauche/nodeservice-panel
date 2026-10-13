/** Байты в секунду → Мбит/с, как в Remnawave. */
export const toMbit = (bytesPerSec: number | null | undefined): number | null =>
  bytesPerSec == null || !Number.isFinite(bytesPerSec) ? null : (bytesPerSec * 8) / 1e6;

/**
 * Одно правило округления скорости во всей панели: меньше 10 Мбит/с — один знак после запятой, иначе целые;
 * в гигабитах (сумма парка) — два знака. Раньше одна и та же скорость читалась «12», «12,3» и «12,34».
 */
export const speedDigits = (mbit: number, giga = false): number => (giga ? 2 : Math.abs(mbit) < 10 ? 1 : 0);

/** Скорость текстом: в Мбит/с или, с `giga`, в Гбит/с (значение — в Мбит/с). */
export function mbitText(mbit: number | null | undefined, giga = false): string {
  if (mbit == null || !Number.isFinite(mbit) || mbit < 0) return '—';
  const digits = speedDigits(mbit, giga);
  return (giga ? mbit / 1000 : mbit).toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
