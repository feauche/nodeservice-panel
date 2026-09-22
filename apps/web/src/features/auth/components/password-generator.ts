/**
 * Генератор пароля для мастера первого запуска: 5 групп по 4 символа через дефис,
 * алфавит без похожих знаков (0/O, 1/l/I) — такой пароль можно прочитать и перепечатать.
 * 20 символов из 54 ≈ 115 бит энтропии; источник — crypto.getRandomValues.
 */
export const GENERATED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
export const GENERATED_GROUPS = 5;
export const GENERATED_GROUP_LEN = 4;

export function generatePassword(): string {
  const total = GENERATED_GROUPS * GENERATED_GROUP_LEN;
  const bytes = new Uint32Array(total);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (n) => GENERATED_ALPHABET[n % GENERATED_ALPHABET.length] ?? 'x');
  const groups: string[] = [];
  for (let i = 0; i < total; i += GENERATED_GROUP_LEN) {
    groups.push(chars.slice(i, i + GENERATED_GROUP_LEN).join(''));
  }
  return groups.join('-');
}
