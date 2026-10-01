import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type WatchdogStatus,
  type WatchdogTestResponse,
  watchdogInstallRequestSchema,
  watchdogStatusSchema,
  watchdogTestResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { Audit } from '../audit/audit.decorator.js';
import { StepUpGuard } from '../security/step-up.guard.js';
import { WatchdogService } from './watchdog.service.js';

class WatchdogStatusDto extends createZodDto(watchdogStatusSchema) {}
class WatchdogInstallRequestDto extends createZodDto(watchdogInstallRequestSchema) {}
class WatchdogTestResponseDto extends createZodDto(watchdogTestResponseSchema) {}

const TARGET = { type: 'settings', id: 'watchdog', display: 'Сторож панели' } as const;

/** «Настройки → Уведомления → Сторож панели»: поставить на сервер парка, убрать, проверить. */
@ApiTags('settings')
@ApiCookieAuth()
@Controller('settings/watchdog')
export class WatchdogController {
  constructor(private readonly watchdog: WatchdogService) {}

  @Get()
  @ApiOperation({ summary: 'Где стоит сторож панели и можно ли его поставить' })
  @ApiOkResponse({ type: WatchdogStatusDto })
  status(): Promise<WatchdogStatus> {
    return this.watchdog.status();
  }

  @Post('install')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  @Audit('settings.watchdog.installed', { target: TARGET })
  @ApiOperation({
    summary:
      'Поставить сторожа: панель по SSH кладёт на сервер скрипт, настройки с токеном бота и таймер (step-up)',
  })
  @ApiOkResponse({ type: WatchdogStatusDto })
  install(@Body() body: WatchdogInstallRequestDto): Promise<WatchdogStatus> {
    return this.watchdog.install(body.serverId);
  }

  @Post('remove')
  @HttpCode(200)
  @Audit('settings.watchdog.removed', { target: TARGET })
  @ApiOperation({ summary: 'Убрать сторожа с сервера' })
  @ApiOkResponse({ type: WatchdogStatusDto })
  remove(): Promise<WatchdogStatus> {
    return this.watchdog.remove();
  }

  @Post('test')
  @HttpCode(200)
  @Audit('settings.watchdog.test', { target: TARGET })
  @ApiOperation({ summary: 'Сторож присылает тестовое сообщение и говорит, видит ли панель' })
  @ApiOkResponse({ type: WatchdogTestResponseDto })
  test(): Promise<WatchdogTestResponse> {
    return this.watchdog.test();
  }
}
