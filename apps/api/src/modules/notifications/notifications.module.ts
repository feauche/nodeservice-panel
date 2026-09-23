import { Global, Module } from '@nestjs/common';

import { NotificationsController } from './notifications.controller.js';
import { NotificationsEvents } from './notifications.events.js';
import { NotificationsRepository } from './notifications.repository.js';
import { NotificationsService } from './notifications.service.js';

/** Центр уведомлений. Global — чтобы `push()` был доступен любому модулю без импорта. */
@Global()
@Module({
  controllers: [NotificationsController],
  providers: [NotificationsRepository, NotificationsService, NotificationsEvents],
  exports: [NotificationsService],
})
export class NotificationsModule {}
