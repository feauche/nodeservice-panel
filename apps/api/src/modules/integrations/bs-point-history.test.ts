import type { AuditEntry } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { diffText, exitsDiff, historyItem } from './bs-point-history.js';

const ex = (host: string, over = {}) => ({
  host,
  port: 441,
  weight: 1,
  backup: false,
  enabled: true,
  ...over,
});

describe('что изменили в серверах точки', () => {
  it('добавлено, убрано, изменено: вес, роль, включённость', () => {
    const d = exitsDiff(
      [ex('1.1.1.1'), ex('2.2.2.2'), ex('3.3.3.3')],
      [
        ex('1.1.1.1', { weight: 3 }),
        ex('3.3.3.3', { backup: true, enabled: false }),
        ex('4.4.4.4', { backup: true }),
      ],
    );
    expect(d.added).toEqual(['4.4.4.4:441 (запасной)']);
    expect(d.removed).toEqual(['2.2.2.2:441']);
    expect(d.changed).toEqual(['1.1.1.1:441: вес 1 → 3', '3.3.3.3:441: стал запасным, выключен']);
    expect(diffText(d)).toBe(
      'добавлен 4.4.4.4:441 (запасной); убран 2.2.2.2:441; 1.1.1.1:441: вес 1 → 3; 3.3.3.3:441: стал запасным, выключен',
    );
  });

  it('без изменений — пусто', () => {
    expect(diffText(exitsDiff([ex('1.1.1.1')], [ex('1.1.1.1')]))).toBeNull();
  });
});

const entry = (over: Partial<AuditEntry>): AuditEntry =>
  ({
    id: '0192c000-0000-7000-8000-000000000001',
    seq: 1,
    occurredAt: '2026-10-14T12:00:00.000Z',
    actorType: 'admin',
    actorId: 'u1',
    actorDisplay: 'admin',
    action: 'integration.bs.ws_exits_changed',
    category: 'settings',
    targetType: 'bs_ws',
    targetId: '5',
    targetDisplay: 'WS-5',
    result: 'ok',
    severity: 'info',
    source: 'manual',
    ip: null,
    userAgent: null,
    requestId: null,
    durationMs: null,
    changes: null,
    metadata: {},
    ...over,
  }) as AuditEntry;

describe('строка истории точки из записи Журнала', () => {
  it('изменение серверов: что именно поменяли и кто', () => {
    expect(
      historyItem(entry({ metadata: { added: ['4.4.4.4:441'], removed: [], changed: [] } })),
    ).toMatchObject({
      tone: 'acc',
      title: 'Серверы изменены',
      detail: 'добавлен 4.4.4.4:441',
      by: 'вы',
    });
    expect(historyItem(entry({ result: 'failed' }))).toMatchObject({
      tone: 'crit',
      title: 'Серверы не изменены',
    });
  });

  it('итог проверки точкой: все работают или какие не отвечают', () => {
    const verified = (metadata: Record<string, unknown>) =>
      historyItem(entry({ action: 'integration.bs.ws_exits_verified', actorType: 'system', metadata }));
    expect(verified({ total: 3, working: 3, failing: [] })).toMatchObject({
      tone: 'ok',
      title: 'Точка проверила серверы',
      detail: 'все 3 работают',
      by: 'панель',
    });
    expect(verified({ total: 3, working: 2, failing: ['31.56.188.142:441'] })).toMatchObject({
      tone: 'crit',
      title: 'Сервер не отвечает точке',
      detail: '31.56.188.142:441',
    });
  });

  it('просмотр настроек подключения; чужие действия к истории не относятся', () => {
    expect(historyItem(entry({ action: 'integration.bs.ws_connect_viewed' }))).toMatchObject({
      tone: 'muted',
      title: 'Открыты настройки подключения',
    });
    expect(historyItem(entry({ action: 'integration.dns.record_changed' }))).toBeNull();
  });
});
