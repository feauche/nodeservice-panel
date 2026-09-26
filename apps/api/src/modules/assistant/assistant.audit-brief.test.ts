import type { AuditEntry } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { auditBrief } from './assistant.audit-brief.js';

const entry = (over: Partial<AuditEntry> = {}): AuditEntry =>
  ({
    id: 'e1',
    seq: 1,
    occurredAt: '2026-09-26T10:00:00.000Z',
    actorType: 'admin',
    actorId: 'u1',
    actorDisplay: 'lumaxadmnode',
    action: 'assistant.chat',
    category: 'assistant',
    targetType: 'assistant',
    targetId: 'c1',
    targetDisplay: 'Беседа',
    result: 'ok',
    severity: 'info',
    source: 'manual',
    ip: '203.0.113.7',
    userAgent: 'Safari',
    requestId: 'r1',
    durationMs: 5,
    changes: null,
    metadata: {},
    ...over,
  }) as AuditEntry;

describe('auditBrief', () => {
  it('кто, что, результат, цель; технические поля (ip, браузер, id запроса) не попадают', () => {
    const b = auditBrief(entry());
    expect(b).toMatchObject({
      who: 'lumaxadmnode',
      result: 'ok',
      severity: 'info',
      source: 'manual',
      target: 'Беседа',
      action: 'assistant.chat',
    });
    expect(JSON.stringify(b)).not.toMatch(/203\.0\.113|Safari|r1/);
    expect(b.what).not.toBe('assistant.chat');
  });
  it('запрос к Джарвису даёт вопрос и ответ в деталях, системные события подписаны «панель»', () => {
    const b = auditBrief(
      entry({
        actorType: 'system',
        actorDisplay: 'Система',
        metadata: { question: 'Что с ru?', answer: 'Нода остановлена', toolCalls: 3, proposals: 0 },
      }),
    );
    expect(b.who).toBe('панель');
    expect(b.details).toContain('question: Что с ru?');
    expect(b.details).toContain('answer: Нода остановлена');
    expect(b.details).not.toContain('toolCalls');
  });
  it('секреты в деталях маскируются, длинное обрезается', () => {
    const b = auditBrief(
      entry({ metadata: { error: `password=hunter2-secret ${'очень длинный текст '.repeat(40)}` } }),
    );
    expect(b.details).not.toContain('hunter2');
    expect((b.details ?? '').length).toBeLessThan(320);
  });
  it('изменения: поле до и после, поля с секретными названиями без значений', () => {
    const b = auditBrief(
      entry({
        action: 'server.updated',
        changes: {
          providerId: { before: 'aeza', after: 'hetzner' },
          sshPassword: { before: 'a', after: 'b' },
        },
      }),
    );
    expect(b.changes).toEqual(['providerId: aeza → hetzner', 'sshPassword: изменено']);
  });
});
