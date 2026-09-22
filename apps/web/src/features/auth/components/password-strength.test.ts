import { describe, expect, it } from 'vitest';

import { isLeakedPassword, LEAKED_WORDS, passwordScore, passwordStrength } from './password-strength';

describe('passwordStrength', () => {
  it('пустой — 0 и подсказка по умолчанию', () => {
    expect(passwordScore('')).toBe(0);
    expect(passwordStrength('')).toMatchObject({ level: 0, leaked: false });
    expect(passwordStrength('').label).toContain('От 12 символов');
  });

  it('оценка растёт с длиной, регистром и цифрами/символами', () => {
    expect(passwordScore('abc')).toBe(0);
    expect(passwordScore('abcdefgh')).toBe(1); // ≥8
    expect(passwordScore('abcdefghijkl')).toBe(2); // ≥12
    expect(passwordScore('Abcdefghijkl')).toBe(3); // + регистр
    expect(passwordScore('Abcdefghijk1')).toBe(4); // + цифра
    expect(passwordScore('a'.repeat(20))).toBe(3); // 8, 12, 20
    expect(passwordScore('Кит плывёт на юг 2026')).toBe(4);
  });

  it('утечки: все 13 слов из демо, регистронезависимо и как подстрока', () => {
    expect(LEAKED_WORDS).toHaveLength(13);
    for (const w of LEAKED_WORDS) expect(isLeakedPassword(`xx${w.toUpperCase()}yy`)).toBe(true);
    expect(isLeakedPassword('correct horse battery')).toBe(false);
    const s = passwordStrength('MyPassword2026!!');
    expect(s).toMatchObject({ level: 1, leaked: true });
    expect(s.label).toBe('Встречается в утечках: не подойдёт');
  });

  it('подписи и «нужно ещё N символов»', () => {
    expect(passwordStrength('abcdefgh').label).toBe('Слабый: подберут за минуты · нужно ещё 4 символа');
    expect(passwordStrength('abcdefghijk').label).toContain('нужно ещё 1 символ');
    expect(passwordStrength('abcdefghijkl').label).toBe('Средний: добавьте длины');
    expect(passwordStrength('Abcdefghijkl').label).toBe('Хороший');
    expect(passwordStrength('Abcdefghijk1').label).toBe('Надёжный: подбор займёт годы');
    expect(passwordStrength('', 'своя подсказка').label).toBe('своя подсказка');
  });
});
