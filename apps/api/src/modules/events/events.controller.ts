import { Controller, Header, type MessageEvent, Sse } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { interval, map, merge, Observable } from 'rxjs';

import { EventsService, type PanelEvent } from './events.service.js';

/** Пинг держит соединение живым за прокси и позволяет браузеру заметить обрыв. */
const SSE_PING_MS = 20_000;

@ApiTags('events')
@ApiCookieAuth()
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({ summary: 'Живые события панели: уведомления, серверы, инциденты (SSE)' })
  stream(): Observable<MessageEvent> {
    const live$ = new Observable<PanelEvent>((subscriber) => this.events.on((e) => subscriber.next(e)));
    const ping$ = interval(SSE_PING_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: '' })));
    return merge(live$.pipe(map((e): MessageEvent => ({ type: e.type, data: e.data }))), ping$);
  }
}
