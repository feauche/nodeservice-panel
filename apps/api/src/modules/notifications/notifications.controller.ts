import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  type MessageEvent,
  Param,
  ParseUUIDPipe,
  Post,
  Sse,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createNotificationRequestSchema,
  type Notification,
  type NotificationsResponse,
  notificationSchema,
  notificationsResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { interval, map, merge, Observable } from 'rxjs';

import { NotificationsEvents } from './notifications.events.js';
import { NotificationsService } from './notifications.service.js';

const SSE_PING_MS = 20_000;

export class NotificationDto extends createZodDto(notificationSchema) {}
export class NotificationsResponseDto extends createZodDto(notificationsResponseSchema) {}
export class CreateNotificationRequestDto extends createZodDto(createNotificationRequestSchema) {}

@ApiTags('notifications')
@ApiCookieAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly events: NotificationsEvents,
  ) {}

  /**
   * Живой поток: событие `notification` на каждое новое уведомление (сервер или другая вкладка),
   * `ping` каждые 20 с. Клиент по нему перечитывает колокольчик и инциденты — без ожидания опроса.
   */
  @Sse('stream')
  @Header('X-Accel-Buffering', 'no')
  @ApiOperation({ summary: 'Уведомления: SSE-поток новых записей' })
  stream(): Observable<MessageEvent> {
    const live$ = new Observable<Notification>((subscriber) => this.events.on((n) => subscriber.next(n)));
    const ping$ = interval(SSE_PING_MS).pipe(map((): MessageEvent => ({ type: 'ping', data: '' })));
    return merge(live$.pipe(map((n): MessageEvent => ({ type: 'notification', data: n }))), ping$);
  }

  @Get()
  @ApiOperation({ summary: 'Центр уведомлений: последние записи, число непрочитанных' })
  @ApiOkResponse({ type: NotificationsResponseDto })
  list(): Promise<NotificationsResponse> {
    return this.notifications.list();
  }

  @Post()
  @ApiOperation({ summary: 'Сохранить всплывашку клиента в центр уведомлений' })
  @ApiOkResponse({ type: NotificationDto })
  create(@Body() body: CreateNotificationRequestDto): Promise<Notification> {
    return this.notifications.create(body);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiOperation({ summary: 'Отметить все прочитанными' })
  readAll(): Promise<{ unread: number }> {
    return this.notifications.markAllRead();
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Очистить все уведомления' })
  clear(): Promise<void> {
    return this.notifications.clear();
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Удалить одно уведомление' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.notifications.delete(id);
  }
}
