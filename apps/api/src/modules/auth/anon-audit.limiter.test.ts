import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditRecordInput, AuditService } from '../audit/audit.service.js';
import { ANON_AUDIT_LIMITS, AnonAuditLimiter, AUDIT_PATH_MAX, clipPath } from './anon-audit.limiter.js';
import { deleteByPattern, testValkey } from './test-valkey.js';

describe('AnonAuditLimiter (Valkey)', () => {
  let valkey: Redis;
  let limiter: AnonAuditLimiter;
  let written: AuditRecordInput[];
  /** Своя «минута» на каждый тест (далеко в будущем): счётчики тестов и соседних запусков не пересекаются. */
  let minute = 40_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
  const entry = (n: number): AuditRecordInput => ({ action: 'auth.csrf.denied', metadata: { n } });
  const summaries = () => written.filter((w) => w.action === 'auth.denied.summary');

  beforeAll(() => {
    valkey = testValkey();
  });
  afterAll(async () => {
    await deleteByPattern(valkey, 'audit:anon:*');
    await valkey.quit();
  });
  beforeEach(() => {
    minute += 10;
    vi.spyOn(Date, 'now').mockReturnValue(minute * 60_000 + 5_000);
    written = [];
    const audit = {
      record: async (input: AuditRecordInput) => {
        written.push(input);
        return null;
      },
    } as unknown as AuditService;
    limiter = new AnonAuditLimiter(valkey, audit);
  });
  afterEach(async () => {
    await limiter.onModuleDestroy();
    vi.restoreAllMocks();
  });

  it('с одного адреса — пять записей в минуту, остальные уходят в одну сводку', async () => {
    expect(ANON_AUDIT_LIMITS.request).toEqual({ perAddress: 5, total: 30 });
    for (let i = 0; i < 12; i++) await limiter.record('request', '203.0.113.5', entry(i));
    expect(written.map((w) => w.metadata?.n)).toEqual([0, 1, 2, 3, 4]);
    // соседний адрес свой счёт не потерял
    await limiter.record('request', '203.0.113.6', entry(100));
    expect(written).toHaveLength(6);

    await limiter.flush();
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0]).toMatchObject({
      result: 'denied',
      severity: 'warn',
      source: 'auto',
      actor: { type: 'anonymous' },
      metadata: { note: 'Отклонено запросов без входа: ещё 7. По одному они не записаны.' },
    });
    // сводка пишется один раз
    await limiter.flush();
    expect(summaries()).toHaveLength(1);
  });

  it('IPv6: вся сеть /64 — один адрес', async () => {
    for (let i = 1; i <= 8; i++) await limiter.record('request', `2001:db8:5:5::${i}`, entry(i));
    expect(written).toHaveLength(5);
    await limiter.record('request', '2001:db8:5:6::1', entry(9));
    expect(written).toHaveLength(6);
  });

  it('общий потолок — тридцать в минуту: много адресов Журнал не заполнят, и ключей по адресам больше не заводится', async () => {
    for (let i = 0; i < 45; i++) await limiter.record('request', `198.51.100.${i}`, entry(i));
    expect(written).toHaveLength(30);
    expect(await valkey.keys(`audit:anon:request:ip:*:${minute}`)).toHaveLength(30);
    await limiter.flush();
    expect(summaries()[0]?.metadata?.note).toContain('ещё 15');
  });

  it('неудачные попытки входа: своего счёта по адресу нет, потолок общий и отдельный от запросов', async () => {
    for (let i = 0; i < 30; i++) await limiter.record('request', `198.51.100.${i}`, entry(i));
    for (let i = 0; i < 34; i++) await limiter.record('login', '203.0.113.9', entry(i));
    expect(written).toHaveLength(60);
    await limiter.flush();
    expect(summaries().map((s) => s.metadata?.note)).toEqual([
      'Записей о неудачных попытках входа: ещё 4. По одной они не записаны.',
    ]);
  });

  it('новая минута — новый счёт; сводка за прошлую минуту не теряется', async () => {
    for (let i = 0; i < 7; i++) await limiter.record('request', '203.0.113.5', entry(i));
    vi.spyOn(Date, 'now').mockReturnValue((minute + 1) * 60_000 + 5_000);
    for (let i = 0; i < 6; i++) await limiter.record('request', '203.0.113.5', entry(i));
    expect(written).toHaveLength(10);
    // сводка только за закончившуюся минуту — текущая ещё идёт
    await limiter.flush(minute + 1);
    expect(summaries().map((s) => s.metadata?.note)).toEqual([
      'Отклонено запросов без входа: ещё 2. По одному они не записаны.',
    ]);
    await limiter.flush();
    expect(summaries()).toHaveLength(2);
  });

  it('счёт недоступен — запись не пишется: поток без предела в Журнал не попадёт', async () => {
    const broken = {
      eval: async () => {
        throw new Error('OOM command not allowed');
      },
      getdel: async () => null,
    } as unknown as Redis;
    const audit = { record: vi.fn(async () => null) } as unknown as AuditService;
    const closed = new AnonAuditLimiter(broken, audit);
    await closed.record('request', '203.0.113.5', entry(1));
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('clipPath обрезает длинный путь', () => {
    expect(AUDIT_PATH_MAX).toBe(200);
    expect(clipPath('/api/servers')).toBe('/api/servers');
    const long = clipPath(`/api/x?${'a'.repeat(5000)}`);
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
