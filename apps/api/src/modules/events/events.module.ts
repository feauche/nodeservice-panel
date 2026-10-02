import { Global, Module } from '@nestjs/common';

import { SessionChannelsModule } from '../auth/session-channels.module.js';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

/** Шина живых событий. Global — чтобы любой репозиторий или сервис мог `emit()` без импорта. */
@Global()
@Module({
  imports: [SessionChannelsModule],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
