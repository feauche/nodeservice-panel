import { describe, expect, it, vi } from 'vitest';

import { NotificationsService } from './notifications.service.js';

/** Минимальный сервис: колокольчик — в память, Telegram — в список. */
function make() {
  const sent: Array<{ title: string; body: string | null }> = [];
  const bell: string[] = [];
  const svc = new NotificationsService(
    {
      insert: async (r: { title: string }) => (
        bell.push(r.title), { ...r, id: 'n', createdAt: new Date(), readAt: null }
      ),
    } as never,
    { emit: () => undefined } as never,
    { dispatch: async (m: { title: string; body: string | null }) => void sent.push(m) } as never,
  );
  return { svc, sent, bell };
}

describe('Telegram ждёт разбора Джарвиса', () => {
  it('колокольчик сразу, Telegram — после разбора и с выводом первым блоком', async () => {
    const { svc, sent, bell } = make();
    await svc.push({
      severity: 'crit',
      title: 'Сервер недоступен · guardora',
      body: 'Онлайн: 476 → 0',
      telegram: { event: 'incident_crit', incidentId: 'i1', kind: 'server_down', awaitAnalysis: true },
    });
    expect(bell).toHaveLength(1);
    expect(sent).toHaveLength(0);
    svc.releaseAfterAnalysis(
      'i1',
      'Оплата просрочена на 15 часов — вероятно, отключили за неоплату.',
      'high',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatch(/^🤖 Разбор Джарвиса \(уверенность высокая\): Оплата просрочена/);
    expect(sent[0]?.body).toContain('Онлайн: 476 → 0');
    svc.releaseAfterAnalysis('i1', 'повтор');
    expect(sent).toHaveLength(1);
  });

  it('разбор не пришёл — через время ожидания уходит как есть', async () => {
    vi.useFakeTimers();
    const { svc, sent } = make();
    await svc.push({
      severity: 'crit',
      title: 't',
      body: 'b',
      telegram: { event: 'incident_crit', incidentId: 'i2', awaitAnalysis: true },
    });
    vi.advanceTimersByTime(60);
    expect(sent).toEqual([expect.objectContaining({ body: 'b' })]);
    vi.useRealTimers();
  });
});
