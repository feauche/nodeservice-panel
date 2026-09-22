import type { Redis } from 'ioredis';
import { generate, generateSecret } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteByPattern, testValkey } from './test-valkey.js';
import { isReplay, TotpService } from './totp.service.js';

describe('isReplay', () => {
  it('без истории — не повтор; шаг <= последнего — повтор', () => {
    expect(isReplay(100, null)).toBe(false);
    expect(isReplay(100, 99)).toBe(false);
    expect(isReplay(100, 100)).toBe(true);
    expect(isReplay(99, 100)).toBe(true);
  });
});

describe('TotpService (Valkey)', () => {
  let valkey: Redis;
  let svc: TotpService;
  const userId = 'test-user-totp';

  beforeAll(async () => {
    valkey = testValkey();
    svc = new TotpService(valkey);
    await deleteByPattern(valkey, `totp:last:${userId}`);
  });
  afterAll(async () => {
    await svc.forget(userId);
    await valkey.quit();
  });

  it('enroll: секрет base32, otpauth-URI с issuer, QR как data-URL svg', async () => {
    const e = await svc.enroll('admin');
    expect(e.secret).toMatch(/^[A-Z2-7]+=*$/);
    expect(e.otpauthUrl).toMatch(/^otpauth:\/\/totp\/NodeService(%3A|:)admin\?/);
    expect(e.otpauthUrl).toContain('issuer=NodeService');
    expect(e.otpauthUrl).toContain(`secret=${e.secret}`);
    expect(e.qrDataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const svg = Buffer.from(e.qrDataUrl.split(',')[1] ?? '', 'base64').toString('utf8');
    expect(svg).toContain('<svg');
  });

  it('верный код принимается один раз, повтор и мусор отклоняются', async () => {
    const secret = generateSecret();
    const code = await generate({ secret });
    expect(await svc.verify(userId, secret, code)).toBe(true);
    // тот же код в том же шаге — повтор
    expect(await svc.verify(userId, secret, code)).toBe(false);
    expect(await svc.verify(userId, secret, '000000')).toBe(false);
    const last = await valkey.get(`totp:last:${userId}`);
    expect(Number(last)).toBeGreaterThan(0);
  });

  it('ошибка otplib (шаг далеко позади последнего принятого) → false, не исключение', async () => {
    const secret = generateSecret();
    await valkey.set(`totp:last:${userId}`, String(Math.floor(Date.now() / 1000 / 30) + 1000));
    const code = await generate({ secret });
    await expect(svc.verify(userId, secret, code)).resolves.toBe(false);
    await expect(svc.verify(userId, secret, 'abc')).resolves.toBe(false);
    await svc.forget(userId);
  });

  it('adopt переносит последний шаг на другой ключ', async () => {
    await svc.forget(userId);
    const secret = generateSecret();
    expect(await svc.verify(`setup:${userId}`, secret, await generate({ secret }))).toBe(true);
    await svc.adopt(`setup:${userId}`, userId);
    expect(await valkey.get(`totp:last:setup:${userId}`)).toBeNull();
    expect(Number(await valkey.get(`totp:last:${userId}`))).toBeGreaterThan(0);
    // тот же шаг под новым ключом — повтор
    expect(await svc.verify(userId, secret, await generate({ secret }))).toBe(false);
  });

  it('код предыдущего шага (в окне ±1) принимается, если новее последнего принятого', async () => {
    await svc.forget(userId);
    const secret = generateSecret();
    const prev = await generate({ secret, epoch: Math.floor(Date.now() / 1000) - 30 });
    expect(await svc.verify(userId, secret, prev)).toBe(true);
    const cur = await generate({ secret });
    // текущий шаг > предыдущего — ок (если они не совпали из-за границы периода)
    if (cur !== prev) expect(await svc.verify(userId, secret, cur)).toBe(true);
    // а назад — уже нет
    expect(await svc.verify(userId, secret, prev)).toBe(false);
  });
});
