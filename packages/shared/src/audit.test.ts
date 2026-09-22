import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  auditActionLabel,
  auditEntrySchema,
  auditListQuerySchema,
} from './audit.js';

describe('audit contract', () => {
  it('у каждого действия категория из списка и русская подпись', () => {
    for (const [key, def] of Object.entries(AUDIT_ACTIONS)) {
      expect(AUDIT_CATEGORIES).toContain(def.category);
      expect(def.label.length).toBeGreaterThan(3);
      expect(key.startsWith(`${def.category}.`)).toBe(true);
    }
    expect(auditActionLabel('auth.login.success')).toBe('Вход в панель');
    expect(auditActionLabel('unknown.action')).toBe('unknown.action');
  });

  it('query: списки через запятую и массивом, дефолты страницы', () => {
    const a = auditListQuerySchema.parse({ category: 'auth,settings', result: ['ok', 'ok'] });
    expect(a).toMatchObject({ page: 1, pageSize: 25, category: ['auth', 'settings'], result: ['ok'] });
    expect(auditListQuerySchema.parse({ category: '' }).category).toBeUndefined();
    expect(auditListQuerySchema.safeParse({ category: 'nope' }).success).toBe(false);
    expect(auditListQuerySchema.safeParse({ pageSize: 1000 }).success).toBe(false);
  });

  it('entry: валидная запись проходит, дата без смещения — нет', () => {
    const base = {
      id: '0192b6e0-4c1e-7c3a-9c2d-5f6a7b8c9d0e',
      seq: 1,
      occurredAt: '2026-08-29T18:00:00.000Z',
      actorType: 'admin',
      actorId: 'u1',
      actorDisplay: 'admin',
      action: 'auth.login.success',
      category: 'auth',
      targetType: null,
      targetId: null,
      targetDisplay: null,
      result: 'ok',
      severity: 'info',
      source: 'manual',
      ip: '127.0.0.1',
      userAgent: 'test',
      requestId: 'r1',
      durationMs: 12,
      changes: null,
      metadata: {},
    };
    expect(auditEntrySchema.safeParse(base).success).toBe(true);
    expect(auditEntrySchema.safeParse({ ...base, occurredAt: '2026-08-29 18:00' }).success).toBe(false);
  });
});
