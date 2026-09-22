import { describe, expect, it } from 'vitest';

import { changePasswordRequestSchema, securityPolicySchema, securityPolicyUpdateSchema } from './security.js';

describe('security contract', () => {
  it('политика: дефолты и границы', () => {
    expect(securityPolicySchema.parse({})).toEqual({
      idleMinutes: 360,
      lockAfterMinutes: 30,
      alwaysAskTotp: false,
    });
    expect(securityPolicySchema.safeParse({ idleMinutes: 1 }).success).toBe(false);
    expect(securityPolicyUpdateSchema.parse({ alwaysAskTotp: true })).toEqual({ alwaysAskTotp: true });
  });
  it('смена пароля: новый ≠ текущий и ≥ 12 символов', () => {
    const same = changePasswordRequestSchema.safeParse({
      currentPassword: 'correct horse battery',
      newPassword: 'correct horse battery',
    });
    expect(same.success).toBe(false);
    expect(
      changePasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success,
    ).toBe(false);
    expect(
      changePasswordRequestSchema.safeParse({ currentPassword: 'x', newPassword: 'a much longer password 1' })
        .success,
    ).toBe(true);
  });
});
