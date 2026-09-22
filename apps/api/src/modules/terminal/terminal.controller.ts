import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  TERMINAL_HISTORY_LIMIT,
  TERMINAL_SEARCH_MAX,
  TERMINAL_WS_PATH,
  type TerminalOpenResponse,
  type TerminalSessionDetail,
  type TerminalSessionsResponse,
  terminalOpenResponseSchema,
  terminalSessionDetailSchema,
  terminalSessionsResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import { ServersService } from '../servers/servers.service.js';
import { TerminalSessionsRepository } from './terminal-sessions.repository.js';

export class TerminalOpenResponseDto extends createZodDto(terminalOpenResponseSchema) {}
export class TerminalSessionsResponseDto extends createZodDto(terminalSessionsResponseSchema) {}
export class TerminalSessionDetailDto extends createZodDto(terminalSessionDetailSchema) {}

/**
 * Веб-терминал: preflight (ws-адрес) и история сессий сервера.
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
    private readonly history: TerminalSessionsRepository,
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

  @Get('sessions')
  @ApiOperation({ summary: 'История терминала: последние сессии сервера, поиск по записям' })
  @ApiQuery({ name: 'q', required: false, description: 'Строка поиска по записям (без регистра)' })
  @ApiQuery({ name: 'since', required: false, description: 'Только сессии, начатые не раньше (ISO 8601)' })
  @ApiOkResponse({ type: TerminalSessionsResponseDto })
  async sessions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limitRaw?: string,
    @Query('q') qRaw?: string,
    @Query('since') sinceRaw?: string,
  ): Promise<TerminalSessionsResponse> {
    await this.servers.get(id);
    const n = Number(limitRaw);
    const limit = Number.isInteger(n) && n > 0 ? Math.min(n, TERMINAL_HISTORY_LIMIT) : 50;
    const q = (qRaw ?? '').trim();
    if (q.length > TERMINAL_SEARCH_MAX) {
      throw problem(HttpStatus.BAD_REQUEST, {
        detail: `Строка поиска не длиннее ${TERMINAL_SEARCH_MAX} символов`,
      });
    }
    let since: Date | undefined;
    if (sinceRaw) {
      since = new Date(sinceRaw);
      if (Number.isNaN(since.getTime()))
        throw problem(HttpStatus.BAD_REQUEST, { detail: 'Неверная дата since' });
    }
    return {
      items: await this.history.list(id, limit, { ...(q ? { q } : {}), ...(since ? { since } : {}) }),
    };
  }

  @Get('sessions/:sid')
  @ApiOperation({ summary: 'Сессия терминала с записью вывода' })
  @ApiOkResponse({ type: TerminalSessionDetailDto })
  async session(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sid', ParseUUIDPipe) sid: string,
    @Query('offset') offsetRaw?: string,
  ): Promise<TerminalSessionDetail> {
    await this.servers.get(id);
    const o = Number(offsetRaw);
    const offset = Number.isInteger(o) && o >= 0 ? o : 0;
    const found = await this.history.get(id, sid, offset);
    if (!found) throw problem(HttpStatus.NOT_FOUND, { detail: 'Сессия терминала не найдена' });
    return found;
  }
}
