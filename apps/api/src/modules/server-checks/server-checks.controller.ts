import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiAcceptedResponse, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  runServerCheckRequestSchema,
  type ServerCheckRun,
  type ServerChecksResponse,
  serverCheckKeySchema,
  serverCheckRunSchema,
  serverChecksResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { ServerChecksService } from './server-checks.service.js';

export class ServerChecksResponseDto extends createZodDto(serverChecksResponseSchema) {}
export class ServerCheckRunDto extends createZodDto(serverCheckRunSchema) {}
export class RunServerCheckRequestDto extends createZodDto(runServerCheckRequestSchema) {}

/** Реестр проверок сервера (R5/J9): последние результаты и запуск по кнопке. Без step-up, как обслуживание. */
@ApiTags('server-checks')
@ApiCookieAuth()
@Controller('servers/:id/checks')
export class ServerChecksController {
  constructor(private readonly checks: ServerChecksService) {}

  @Get()
  @ApiOperation({ summary: 'Последний запуск каждой проверки сервера' })
  @ApiOkResponse({ type: ServerChecksResponseDto })
  list(@Param('id', ParseUUIDPipe) id: string): Promise<ServerChecksResponse> {
    return this.checks.list(id);
  }

  @Post(':check/run')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Запустить проверку (409 — на сервере уже идёт другая; тяжёлая — только с confirmHeavy)',
  })
  @ApiAcceptedResponse({ type: ServerCheckRunDto })
  run(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('check') checkRaw: string,
    @Body() body: RunServerCheckRequestDto,
  ): Promise<ServerCheckRun> {
    return this.checks.start(id, serverCheckKeySchema.parse(checkRaw), body.confirmHeavy ?? false);
  }
}
