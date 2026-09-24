import { Global, Module } from '@nestjs/common';

import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';

/** Шина живых событий. Global — чтобы любой репозиторий или сервис мог `emit()` без импорта. */
@Global()
@Module({
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
