import { Body, Controller, Get, HttpCode, Post, Put } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type TelegramSettings,
  type TelegramTestResponse,
  telegramSettingsSchema,
  telegramSettingsUpdateSchema,
  telegramTestRequestSchema,
  telegramTestResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { Audit } from '../../audit/audit.decorator.js';
import { AuditService } from '../../audit/audit.service.js';
import { TelegramService } from './telegram.service.js';

class TelegramSettingsDto extends createZodDto(telegramSettingsSchema) {}
class TelegramSettingsUpdateDto extends createZodDto(telegramSettingsUpdateSchema) {}
class TelegramTestRequestDto extends createZodDto(telegramTestRequestSchema) {}
class TelegramTestResponseDto extends createZodDto(telegramTestResponseSchema) {}

/** «Настройки → Уведомления»: чаты Telegram (токены наружу не отдаются), что слать, тихие часы. */
@ApiTags('settings')
@ApiCookieAuth()
@Controller('settings/telegram')
export class TelegramController {
  constructor(
    private readonly telegram: TelegramService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Настройки Telegram (токены скрыты)' })
  @ApiOkResponse({ type: TelegramSettingsDto })
  get(): Promise<TelegramSettings> {
    return this.telegram.get();
  }

  @Put()
  @Audit('settings.telegram.updated', {
    target: { type: 'settings', id: 'telegram', display: 'Уведомления в Telegram' },
  })
  @ApiOperation({ summary: 'Сохранить чаты, события и тихие часы' })
  @ApiOkResponse({ type: TelegramSettingsDto })
  async update(@Body() body: TelegramSettingsUpdateDto): Promise<TelegramSettings> {
    const { settings, added, removed } = await this.telegram.update(body);
    // Токены в Журнал не пишем — только сколько чатов добавили и убрали и что включено.
    this.audit.extend({
      metadata: {
        chats: settings.destinations.length,
        added,
        removed,
        events: Object.entries(settings.events)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', '),
        quiet: settings.quiet.enabled ? `${settings.quiet.from}–${settings.quiet.to}` : 'выкл',
      },
    });
    return settings;
  }

  @Post('test')
  @HttpCode(200)
  @Audit('settings.telegram.test', {
    target: { type: 'settings', id: 'telegram', display: 'Уведомления в Telegram' },
  })
  @ApiOperation({ summary: 'Отправить тестовое сообщение в один чат' })
  @ApiOkResponse({ type: TelegramTestResponseDto })
  async test(@Body() body: TelegramTestRequestDto): Promise<TelegramTestResponse> {
    const res = await this.telegram.test(body);
    this.audit.extend({ metadata: { ok: res.ok, detail: res.detail, chat: res.chatTitle ?? '—' } });
    return res;
  }
}
