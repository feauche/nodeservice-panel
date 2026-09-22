/** Русское склонение: plural(3, 'символ', 'символа', 'символов') → «символа». */
export function plural(n: number, one: string, few: string, many: string): string {
  const t = Math.abs(n) % 10;
  const h = Math.abs(n) % 100;
  if (t === 1 && h !== 11) return one;
  if (t >= 2 && t <= 4 && (h < 10 || h >= 20)) return few;
  return many;
}
