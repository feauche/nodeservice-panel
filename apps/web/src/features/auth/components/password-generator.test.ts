import { describe, expect, it } from 'vitest';

import { GENERATED_ALPHABET, generatePassword } from './password-generator';
import { passwordStrength } from './password-strength';

describe('generatePassword', () => {
  it('формат: 5 групп по 4 символа через дефис, только читаемые символы', () => {
    for (let i = 0; i < 50; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){4}$/);
      for (const ch of p.replaceAll('-', '')) expect(GENERATED_ALPHABET).toContain(ch);
    }
  });

  it('каждый раз новый и проходит как «отличная» стойкость', () => {
    const a = generatePassword();
    const b = generatePassword();
    expect(a).not.toBe(b);
    expect(passwordStrength(a)).toMatchObject({ level: 4, leaked: false });
  });
});
