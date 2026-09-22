import { Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { TERMINAL_WS_PATH, type TerminalOpenResponse, terminalOpenResponseSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import type { Env } from '../../config/env.schema.js';
import { ServersService } from '../servers/servers.service.js';

export class TerminalOpenResponseDto extends createZodDto(terminalOpenResponseSchema) {}

/**
 * Preflight веб-терминала: проверяет, что сервер существует, и отдаёт ws-адрес.
 * Подтверждение паролем (step-up) не требуется — терминал открывается сразу.
 * Само подключение — по WebSocket на /ws/terminal.
 */
@ApiTags('terminal')
@ApiCookieAuth()
@Controller('servers/:id/terminal')
export class TerminalController {
  constructor(
    private readonly servers: ServersService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: 'Открыть веб-терминал: ws-адрес' })
  @ApiOkResponse({ type: TerminalOpenResponseDto })
  async open(@Param('id', ParseUUIDPipe) id: string): Promise<TerminalOpenResponse> {
    await this.servers.get(id);
    const base = this.config.get('PUBLIC_URL').replace(/^http/, 'ws');
    return { url: `${base}${TERMINAL_WS_PATH}?server=${id}` };
  }
}
