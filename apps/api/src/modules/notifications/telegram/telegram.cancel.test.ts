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
});
