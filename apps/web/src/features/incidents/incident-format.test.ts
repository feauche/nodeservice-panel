import type { Incident, IncidentEvent } from '@nodeservice/shared';
import { describe, expect, it } from 'vitest';

import { closedAtMs, outcomeSentence, titleOnly } from './incident-format';

const NOW = Date.parse('2026-09-25T12:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

const base = (over: Partial<Incident>): Incident => ({
  id: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c4d',
  serverId: '7d9a2b1c-3e4f-4a5b-8c6d-9e0f1a2b3c4e',
  serverName: 'de-fra-01',
  kind: 'disk_high',
  severity: 'warn',
  status: 'resolved',
  title: 'Диск заполняется · de-fra-01',
  detail: '',
  openedAt: iso(60),
  resolvedAt: iso(10),
  resolvedBy: 'auto',
  timeline: [],
  attempts: [],
  proposal: null,
  snapshot: null,
  analysis: null,
  ...over,
});

const step = (result: IncidentEvent['result'], by: 'auto' | 'manual' = 'auto'): IncidentEvent => ({
  at: iso(30),
  by,
  action: 'Выполнено: Освободить диск',
  result,
});

describe('outcomeSentence', () => {
  it('чистое «прошло само» — когда проблема ушла без вмешательства', () => {
    expect(outcomeSentence(base({}))).toBe('Прошло само');
  });
  it('закрытое вручную', () => {
    expect(outcomeSentence(base({ resolvedBy: 'manual' }))).toBe('Закрыто администратором');
  });
  it('старое событие, которое закрыл помогший шаг прежних версий: не «прошло само» и без рассказа о попытках', () => {
    const inc = base({ timeline: [step('applied'), step('helped'), step('resolved')] });
    expect(outcomeSentence(inc)).toBe('Проблема устранена');
  });
  it('не помогшие шаги прежних версий не мешают «прошло само»', () => {
    expect(outcomeSentence(base({ timeline: [step('applied'), step('failed')] }))).toBe('Прошло само');
  });
});

describe('closedAtMs', () => {
  it('у решённого — время закрытия, у открытого — открытия', () => {
    expect(closedAtMs(base({}))).toBe(NOW - 10 * 60_000);
    expect(closedAtMs(base({ status: 'open', resolvedAt: null }))).toBe(NOW - 60 * 60_000);
  });
});

describe('строка в списке событий', () => {
  it('заголовок без имени ноды — настоящий, а не подпись вида', () => {
    expect(titleOnly({ title: 'Сервер недоступен — просрочена оплата · guardora (Аренда)' })).toBe(
      'Сервер недоступен — просрочена оплата',
    );
  });

  it('у открытого события нет обещаний автопочинки, ожидания шага и разбора Ассистента', () => {
    const open = { status: 'open' as const, resolvedAt: null, resolvedBy: null };
    // Свежее событие вида с бывшей цепочкой: раньше «Ждём ещё N с», теперь просто наблюдаем.
    expect(outcomeSentence(base({ ...open, kind: 'node_down', openedAt: iso(0) }))).toBe('Наблюдаем');
    // Вид без цепочки: раньше «Автопочинки нет, только уведомление».
    expect(outcomeSentence(base({ ...open, kind: 'node_blocked' }))).toBe('Наблюдаем');
    // Старое предложение шага подтвердить уже нельзя — о нём не пишем.
    const proposal = {
      action: 'free_disk',
      level: 'T1',
      reason: 'x',
      proposedAt: iso(1),
    } as Incident['proposal'];
    expect(outcomeSentence(base({ ...open, proposal }))).toBe('Наблюдаем');
    // Старый разбор Ассистента в строку не попадает.
    const analysis = { status: 'done', verdict: 'Оплата просрочена.' } as unknown as Incident['analysis'];
    expect(outcomeSentence(base({ ...open, analysis }))).toBe('Наблюдаем');
  });
  it('старая неудачная попытка у открытого события — без «Не помогло: …», просто наблюдаем', () => {
    const inc = base({
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      timeline: [step('applied', 'manual'), step('failed', 'manual')],
    });
    expect(outcomeSentence(inc)).toBe('Наблюдаем');
  });
});
