import { describe, expect, it } from 'vitest';

import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  auditActionLabel,
  auditActionsForWord,
  auditCategoryOfPrefix,
  auditEntryMatches,
  auditEntrySchema,
  auditListQuerySchema,
  auditSearchWords,
} from './audit.js';

describe('audit contract', () => {
  it('у каждого действия категория из списка и русская подпись', () => {
    for (const [key, def] of Object.entries(AUDIT_ACTIONS)) {
      expect(AUDIT_CATEGORIES).toContain(def.category);
      expect(def.label.length).toBeGreaterThan(3);
      // Категория следует из префикса ключа (с явными исключениями kb.* и incident.*).
      expect(auditCategoryOfPrefix(key), `ключ ${key}`).toBe(def.category);
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

  it('поиск: слова из колонки «Событие» и части служебного ключа находят действия', () => {
    expect(auditSearchWords('  Вход «агент»  ')).toEqual(['вход', 'агент']);
    const login = auditActionsForWord('вход');
    expect(login).toEqual(expect.arrayContaining(['auth.login.success', 'auth.login.failed']));
    expect(auditActionsForWord('agent').every((a) => a.includes('agent'))).toBe(true);
    expect(auditActionsForWord('нетакогослова')).toEqual([]);
  });

  it('поиск живой ленты: каждое слово — в подписи, ключе или полях записи (начало слова)', () => {
    const entry = {
      action: 'auth.login.success',
      actorDisplay: 'admin',
      targetDisplay: 'de-fra-01',
      requestId: null,
      ip: '203.0.113.10',
      metadata: { login: 'admin' },
    };
    expect(auditEntryMatches(entry, 'вход')).toBe(true);
    expect(auditEntryMatches(entry, 'вход fra')).toBe(true);
    expect(auditEntryMatches(entry, 'login')).toBe(true);
    expect(auditEntryMatches(entry, '203.0.113')).toBe(true);
    expect(auditEntryMatches(entry, 'вход выход')).toBe(false);
    expect(auditEntryMatches(entry, 'ход')).toBe(false); // середина слова не ищется — как у сервера
    expect(auditEntryMatches(entry, '')).toBe(true);
  });
});
