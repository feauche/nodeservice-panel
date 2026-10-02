import {
  TELEGRAM_DELIVERY_DEFAULT,
  TELEGRAM_EVENTS_DEFAULT,
  TELEGRAM_KINDS_DEFAULT,
  TELEGRAM_QUIET_DEFAULT,
} from '@nodeservice/shared';
import { describe, expect, it, vi } from 'vitest';

import { TelegramService } from './telegram.service.js';

describe('отмена ложной тревоги в очереди Telegram', () => {
  it('не выпускает сообщение, которое уже ждёт своего места в темпе чата', async () => {
    const call = vi.fn();
    const service = new TelegramService(
      {} as never,
      { call } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const internals = service as unknown as {
      cancelledIncidents: Set<string>;
      chatNextAt: Map<string, number>;
      sendPaced(destination: unknown, payload: unknown): Promise<{ result: unknown; queued: boolean }>;
    };
    internals.chatNextAt.set('chat-1', Date.now() + 30);
    const sending = internals.sendPaced(
      {
        id: 'chat-1',
        token: 'token',
        chatId: '-1001',
        topic: null,
        proxy: null,
      },
      {
        text: 'ложная тревога',
        buttons: [],
        replyTo: null,
        silent: false,
        rich: null,
        incidentId: 'incident-1',
        event: 'incident_crit',
      },
    );
    internals.cancelledIncidents.add('incident-1');

    await expect(sending).resolves.toEqual({ result: null, queued: false });
    expect(call).not.toHaveBeenCalled();
  });

  it('не присылает одинокое «Починилось», если исходная тревога не была доставлена', async () => {
    const call = vi.fn();
    const settings = {
      destinations: [{ id: 'chat-1' }],
      events: { ...TELEGRAM_EVENTS_DEFAULT },
      kinds: { ...TELEGRAM_KINDS_DEFAULT },
      quiet: { ...TELEGRAM_QUIET_DEFAULT },
      delivery: { ...TELEGRAM_DELIVERY_DEFAULT },
      proxyEnc: null,
    };
    const service = new TelegramService(
      { load: async () => settings } as never,
      { call } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    service.lastMessageAt = vi.fn().mockResolvedValue(null);

    await service.dispatch({
      event: 'resolved',
      incidentId: 'incident-1',
      kind: 'node_blocked',
      title: 'Онлайн восстановился',
    });

    expect(call).not.toHaveBeenCalled();
  });

  it('не шлёт закрытие в чат, который пропустил тревогу, если другой чат её получил', async () => {
    const call = vi.fn();
    const destination = {
      id: 'chat-2',
      token: 'token',
      chatId: '-1002',
      topic: null,
      proxy: null,
      botName: null,
      chatTitle: null,
      lastTest: null,
    };
    const settings = {
      destinations: [{ id: destination.id }],
      events: { ...TELEGRAM_EVENTS_DEFAULT },
      kinds: { ...TELEGRAM_KINDS_DEFAULT },
      quiet: { ...TELEGRAM_QUIET_DEFAULT },
      delivery: { ...TELEGRAM_DELIVERY_DEFAULT },
      proxyEnc: null,
    };
    const service = new TelegramService(
      { load: async () => settings, live: () => [destination] } as never,
      { call } as never,
      {} as never,
      { query: { appMeta: { findFirst: async () => null } } } as never,
      {} as never,
    );
    service.lastMessageAt = vi.fn().mockResolvedValue(new Date());
    const internals = service as unknown as {
      firstMessage: (incidentId: string, destinationId: string) => Promise<number | null>;
    };
    internals.firstMessage = vi.fn().mockResolvedValue(null);

    await service.dispatch({
      event: 'resolved',
      incidentId: 'incident-1',
      kind: 'node_blocked',
      title: 'Онлайн восстановился',
    });

    expect(call).not.toHaveBeenCalled();
  });
});
