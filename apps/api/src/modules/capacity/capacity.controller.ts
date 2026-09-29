import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type Capacity,
  capacitySchema,
  type ServerLink,
  serverLinkSchema,
  serverLinkUpdateSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { Audit } from '../audit/audit.decorator.js';
import { CapacityService } from './capacity.service.js';

export class CapacityDto extends createZodDto(capacitySchema) {}
export class ServerLinkDto extends createZodDto(serverLinkSchema) {}
export class ServerLinkUpdateDto extends createZodDto(serverLinkUpdateSchema) {}

/** Ёмкость парка («Обзор» → «Ёмкость») и канал сервера (замер, значение вручную). */
@ApiTags('fleet')
@ApiCookieAuth()
@Controller()
export class CapacityController {
  constructor(private readonly capacity: CapacityService) {}

  @Get('fleet/capacity')
  @ApiOperation({ summary: 'Сколько ещё людей выдержит каждая нода и во что упрётся первой' })
  @ApiOkResponse({ type: CapacityDto })
  get(): Promise<Capacity> {
    return this.capacity.get();
  }

  @Post('fleet/capacity/refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Пересчитать ёмкость сейчас (заодно посмотреть сетевые карты, если давно)' })
  @ApiOkResponse({ type: CapacityDto })
  async refresh(): Promise<Capacity> {
    await this.capacity.probeStaleLinks();
    return this.capacity.recompute();
  }

  @Put('servers/:id/link')
  @Audit('server.link.updated')
  @ApiOperation({ summary: 'Скорость канала вручную (null — считать автоматически)' })
  @ApiOkResponse({ type: ServerLinkDto })
  setManual(@Param('id', ParseUUIDPipe) id: string, @Body() body: ServerLinkUpdateDto): Promise<ServerLink> {
    return this.capacity.setManual(id, body.manualMbit);
  }

  @Post('servers/:id/link/measure')
  @HttpCode(200)
  @ApiOperation({ summary: 'Замер скорости канала с сервера (≈ 20 с, до ≈ 2 ГБ трафика)' })
  @ApiOkResponse({ type: ServerLinkDto })
  measure(@Param('id', ParseUUIDPipe) id: string): Promise<ServerLink> {
    return this.capacity.measure(id);
  }
}
