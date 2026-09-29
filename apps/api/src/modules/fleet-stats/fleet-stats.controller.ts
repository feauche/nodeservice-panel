import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { type FleetStats, fleetStatsQuerySchema, fleetStatsSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { FleetStatsService } from './fleet-stats.service.js';

export class FleetStatsDto extends createZodDto(fleetStatsSchema) {}
export class FleetStatsQueryDto extends createZodDto(fleetStatsQuerySchema) {}

/** Статистика всего парка за сутки, неделю, 30 или 90 дней («Обзор» → «Статистика»). */
@ApiTags('fleet')
@ApiCookieAuth()
@Controller('fleet')
export class FleetStatsController {
  constructor(private readonly stats: FleetStatsService) {}

  @Get('stats')
  @ApiOperation({ summary: 'Трафик, нагрузка, доступность, стоимость и онлайн нод за период' })
  @ApiOkResponse({ type: FleetStatsDto })
  get(@Query() q: FleetStatsQueryDto): Promise<FleetStats> {
    return this.stats.stats(q.period);
  }
}
