import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { NotificationsService } from './notifications.service.js';

/**
 * Сообщения в Telegram, которые ждут разбора Джарвиса. Будильник на срок ожидания живёт в памяти и
 * перезапуск панели не переживает, а признак «ждёт отправки» лежит в базе. Поэтому сразу после старта и
 * раз в минуту отправляем то, чему пора: разбор закончился, прерван перезапуском или ждали дольше положенного.
 */
@Injectable()
export class DeferredTelegramJob implements OnApplicationBootstrap {
  private readonly log = new Logger(DeferredTelegramJob.name);

  constructor(private readonly notifications: NotificationsService) {}

  /** После старта: оборванные разборы к этому моменту уже помечены «прерван» (это делается при запуске модулей). */
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    void this.run();
  }

  @Interval(60_000)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    await this.run();
  }

  /** Задача не должна падать молча: если она встала, отложенные тревоги перестанут уходить. */
  private async run(): Promise<void> {
    await this.notifications
      .flushDeferred()
      .catch((err) => this.log.warn(`Отложенные сообщения Telegram: ${(err as Error).message}`));
  }
}
