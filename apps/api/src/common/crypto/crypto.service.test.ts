import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../config/env.schema.js';
import { CryptoService, derivePepper } from './crypto.service.js';

function make(version = 1, key = 'ab'.repeat(32), extra: Partial<Env> = {}): CryptoService {
  const values: Partial<Env> = {
    ENCRYPTION_KEY: key,
    ENCRYPTION_KEY_VERSION: version,
    APP_SECRET: 'test-app-secret-0123456789abcdef',
    ...extra,
  };
  const config = { get: (k: keyof Env) => values[k] } as unknown as ConfigService<Env, true>;
  return new CryptoService(config);
}

describe('CryptoService', () => {
  const svc = make();

  it('пароль: хеш argon2id с заданными параметрами, verify работает', async () => {
    const hash = await svc.hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=131072,p=4,t=3\$/);
    expect(await svc.verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await svc.verifyPassword(hash, 'wrong')).toBe(false);
    expect(await svc.verifyPassword('garbage', 'wrong')).toBe(false);
  });

  it('pepper: хеш с другим pepper не проходит; явный PASSWORD_PEPPER имеет приоритет', async () => {
    const hash = await svc.hashPassword('correct horse battery staple');
    const other = make(1, 'ab'.repeat(32), { APP_SECRET: 'another-app-secret-0123456789abcdef' });
    expect(await other.verifyPassword(hash, 'correct horse battery staple')).toBe(false);
    const explicit = make(1, 'ab'.repeat(32), { PASSWORD_PEPPER: 'cd'.repeat(32) });
    const explicitHash = await explicit.hashPassword('correct horse battery staple');
    expect(await explicit.verifyPassword(explicitHash, 'correct horse battery staple')).toBe(true);
    expect(await svc.verifyPassword(explicitHash, 'correct horse battery staple')).toBe(false);
    expect(derivePepper('cd'.repeat(32), 'x')).toEqual(Buffer.from('cd'.repeat(32), 'hex'));
    expect(derivePepper(undefined, 'x')).toHaveLength(32);
    expect(derivePepper(undefined, 'x')).not.toEqual(derivePepper(undefined, 'y'));
  });

  it('verifyAgainstDummy всегда false', async () => {
    expect(await svc.verifyAgainstDummy('anything')).toBe(false);
  });

  it('код восстановления: облегчённые параметры', async () => {
    const hash = await svc.hashRecoveryCode('K7QFM-2M9XT');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,p=1,t=2\$/);
    expect(await svc.verifyRecoveryCode(hash, 'K7QFM-2M9XT')).toBe(true);
    expect(await svc.verifyRecoveryCode(hash, 'K7QFM-2M9XA')).toBe(false);
  });

  it('AES-256-GCM: формат v1:iv:tag:ct, round-trip, разные IV', () => {
    const a = svc.encrypt('JBSWY3DPEHPK3PXP');
    const b = svc.encrypt('JBSWY3DPEHPK3PXP');
    expect(a).toMatch(/^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(svc.decrypt(a)).toBe('JBSWY3DPEHPK3PXP');
    expect(svc.decrypt(b)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('AES-256-GCM: подмена шифротекста или ключа → ошибка', () => {
    const enc = svc.encrypt('secret');
    const [v, iv, tag, ct] = enc.split(':') as [string, string, string, string];
    const flipped = `${v}:${iv}:${tag}:${ct.slice(0, -2)}AA`;
    expect(() => svc.decrypt(flipped)).toThrow();
    expect(() => make(1, 'cd'.repeat(32)).decrypt(enc)).toThrow();
    expect(() => make(2).decrypt(enc)).toThrow(/версии ключа 1/);
    expect(() => svc.decrypt('nonsense')).toThrow(/формат/);
  });

  it('токены: base64url заданной длины, sha256 hex, constant-time compare', () => {
    const t = svc.randomToken(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(svc.sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(svc.constantTimeEqual('abc', 'abc')).toBe(true);
    expect(svc.constantTimeEqual('abc', 'abd')).toBe(false);
    expect(svc.constantTimeEqual('abc', 'abcd')).toBe(false);
  });
});
