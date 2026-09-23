import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  createNotificationRequestSchema,
  type Notification,
  type NotificationsResponse,
  notificationSchema,
  notificationsResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { NotificationsService } from './notifications.service.js';

export class NotificationDto extends createZodDto(notificationSchema) {}
export class NotificationsResponseDto extends createZodDto(notificationsResponseSchema) {}
export class CreateNotificationRequestDto extends createZodDto(createNotificationRequestSchema) {}

@ApiTags('notifications')
@ApiCookieAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

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
