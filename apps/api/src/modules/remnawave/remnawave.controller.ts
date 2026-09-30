import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { remnawaveConnectRequestSchema, remnawaveStatusSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { ServersService } from '../servers/servers.service.js';
import { NodeLinkService } from './node-link.service.js';
import { RemnawaveService } from './remnawave.service.js';

export class RemnawaveStatusDto extends createZodDto(remnawaveStatusSchema) {}
export class RemnawaveConnectRequestDto extends createZodDto(remnawaveConnectRequestSchema) {}

@ApiTags('remnawave')
@ApiCookieAuth()
@Controller('remnawave')
export class RemnawaveController {
  constructor(
    private readonly remnawave: RemnawaveService,
    private readonly servers: ServersService,
    private readonly links: NodeLinkService,
  ) {}

  /** К каждой ноде — серверы панели, на которых она работает: веб сам адреса не сверяет. */
  private async linked(status: RemnawaveStatusDto): Promise<RemnawaveStatusDto> {
    if (status.nodes.length === 0) return status;
    return { ...status, nodes: await this.links.annotate(await this.servers.list(), status.nodes) };
  }

  @Get('status')
  @ApiOperation({ summary: 'Подключение к Remnawave: сводка, ноды, сертификат панели' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  async status(): Promise<RemnawaveStatusDto> {
    return this.linked(await this.remnawave.status());
  }

  @Post('connect')
  @HttpCode(200)
  @ApiOperation({ summary: 'Подключить Remnawave: проверить домен и токен, сохранить при успехе' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  async connect(@Body() body: RemnawaveConnectRequestDto): Promise<RemnawaveStatusDto> {
    return this.linked(await this.remnawave.connect(body));
  }

  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Обновить данные Remnawave прямо сейчас' })
  @ApiOkResponse({ type: RemnawaveStatusDto })
  async refresh(): Promise<RemnawaveStatusDto> {
    return this.linked(await this.remnawave.refresh());
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: 'Отключить Remnawave (стереть домен и токен)' })
  disconnect(): Promise<void> {
    return this.remnawave.disconnect();
  }
}
