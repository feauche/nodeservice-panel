import {
  TELEGRAM_DELIVERY_DEFAULT,
  TELEGRAM_EVENTS_DEFAULT,
  TELEGRAM_KINDS_DEFAULT,
  TELEGRAM_QUIET_DEFAULT,
} from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';

import { TelegramService } from './telegram.service.js';

/** Сообщение волны дописывается правкой (0.106.0); не вышло — тихий ответ, новость не теряется. */
function setup(answer: Record<string, unknown>, kinds = { ...TELEGRAM_KINDS_DEFAULT }) {
  const destination = { id: 'chat-1', token: 'token', chatId: '-1001', topic: null, proxy: null };
  const settings = {
    destinations: [{ id: destination.id }],
    events: { ...TELEGRAM_EVENTS_DEFAULT },
    kinds,
    quiet: { ...TELEGRAM_QUIET_DEFAULT },
    delivery: { ...TELEGRAM_DELIVERY_DEFAULT },
    proxyEnc: null,
  };
  const call = vi.fn(async () => answer);
  const db = {
    query: { appMeta: { findFirst: async () => null } },
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: () => ({ limit: async () => [{ at: new Date('2026-10-15T08:05:00Z') }] }) }),
      }),
    }),
  };
  const service = new TelegramService(
    { load: async () => settings, live: () => [destination] } as never,
    { call } as never,
    { get: () => 'https://panel.example.com' } as never,
    db as never,
    {} as never,
  );
  (service as unknown as { firstMessage: () => Promise<number> }).firstMessage = async () => 4242;
  const dispatch = vi.spyOn(service, 'dispatch').mockResolvedValue(undefined);
  const wave = {
    event: 'incident_crit' as const,
    incidentId: 'wave-1',
    kind: 'wave' as const,
    title: 'Волна · Aeza',
    body: 'Не на связи 3 из 5 нод провайдера (за 10 мин):\n• Польша - 2 (hy2) · с 14:07',
    link: { to: '/incidents/wave-1', label: 'Открыть волну' },
    icon: '🌊',
  };
  const fallback = { event: 'incident_crit' as const, incidentId: 'wave-1', title: 'Ещё нода в волне' };
  return { service, call, dispatch, wave, fallback };
}

describe('правка сообщения волны', () => {
  it('переписывает первое сообщение по делу: значок волны, кнопка, подпись со временем открытия', async () => {
    const t = setup({ ok: true, result: true });
    await t.service.editIncident(t.wave, t.fallback);
    expect(t.call).toHaveBeenCalledTimes(1);
    const [, method, body] = t.call.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
    expect(method).toBe('editMessageText');
    expect(body).toMatchObject({ chat_id: '-1001', message_id: 4242, parse_mode: 'HTML' });
    expect(String(body.text)).toMatch(/^🌊 <b>Волна · Aeza<\/b>/);
    expect(String(body.text)).toContain('Польша - 2 (hy2)');
    expect(body.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Открыть волну', url: 'https://panel.example.com/incidents/wave-1' }]],
    });
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('«сообщение не изменилось» — не ошибка, ответа не нужно', async () => {
    const t = setup({ ok: false, status: 400, description: 'Bad Request: message is not modified' });
    await t.service.editIncident(t.wave, t.fallback);
    expect(t.dispatch).not.toHaveBeenCalled();
  });

  it('править не вышло (сообщение удалили) — тихий ответ на него', async () => {
    const t = setup({ ok: false, status: 400, description: 'Bad Request: message to edit not found' });
    await t.service.editIncident(t.wave, t.fallback);
    expect(t.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Ещё нода в волне', silent: true }),
    );
  });

  it('вид «Волна» выключен в «Какие инциденты» — не правим и не отвечаем', async () => {
    const t = setup({ ok: true, result: true }, { ...TELEGRAM_KINDS_DEFAULT, wave: false });
    await t.service.editIncident(t.wave, t.fallback);
    expect(t.call).not.toHaveBeenCalled();
    expect(t.dispatch).not.toHaveBeenCalled();
  });
});
