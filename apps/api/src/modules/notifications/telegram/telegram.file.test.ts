import { describe, expect, it, vi } from 'vitest';

import { TelegramService } from './telegram.service.js';

const destination = {
  id: 'backup-chat',
  token: 'token',
  chatId: '-1001',
  topic: 7,
  proxy: null,
  botName: null,
  chatTitle: null,
  lastTest: null,
};

describe('файлы Telegram', () => {
  it('передаёт Telegram признак тихой доставки документа', async () => {
    const sendFile = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
    const service = new TelegramService(
      {} as never,
      { sendFile } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.sendFileTo(
        destination,
        { path: '/tmp/backup.part', name: 'backup.part' },
        'Часть 1/2',
        42,
        true,
      ),
    ).resolves.toEqual({ ok: true });

    expect(sendFile).toHaveBeenCalledWith(
      'token',
      expect.objectContaining({
        chat_id: '-1001',
        message_thread_id: '7',
        disable_notification: 'true',
        reply_parameters: JSON.stringify({ message_id: 42, allow_sending_without_reply: true }),
      }),
      { path: '/tmp/backup.part', name: 'backup.part' },
      null,
    );
  });

  it('не отключает звук у обычного документа', async () => {
    const sendFile = vi.fn().mockResolvedValue({ ok: true, result: { message_id: 1 } });
    const service = new TelegramService(
      {} as never,
      { sendFile } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.sendFileTo(
      { ...destination, topic: null },
      { path: '/tmp/report.txt', name: 'report.txt' },
      'Отчёт',
    );

    expect(sendFile.mock.calls[0]?.[1]).not.toHaveProperty('disable_notification');
  });
});
