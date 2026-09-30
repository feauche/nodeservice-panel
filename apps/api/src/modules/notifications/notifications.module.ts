import { Global, Module } from '@nestjs/common';

import { DeferredTelegramJob } from './deferred-telegram.job.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';
import { HttpTelegramClient, TELEGRAM_CLIENT } from './telegram/telegram.client.js';
import { TelegramController } from './telegram/telegram.controller.js';
import { TelegramService } from './telegram/telegram.service.js';
import { TelegramDigestJob } from './telegram/telegram-digest.job.js';
import { TelegramSettingsStore } from './telegram/telegram-settings.store.js';

/**
 * Центр уведомлений и Telegram (R6). Global — чтобы `push()` был доступен любому модулю без импорта;
 * всё, что приходит в push() с пометкой `telegram`, уходит и в чаты Telegram по тумблерам.
 */
@Global()
@Module({
  controllers: [NotificationsController, TelegramController],
  providers: [
    NotificationsRepository,
    NotificationsService,
    TelegramSettingsStore,
    TelegramService,
    TelegramDigestJob,
    DeferredTelegramJob,
    { provide: TELEGRAM_CLIENT, useClass: HttpTelegramClient },
  ],
  exports: [NotificationsService, TelegramService],
})
export class NotificationsModule {}
