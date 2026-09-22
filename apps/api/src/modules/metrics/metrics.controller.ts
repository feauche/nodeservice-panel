import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  OverviewMetricsResponseDto,
  ServerMetricsQueryDto,
  ServerMetricsResponseDto,
} from './metrics.dto.js';
import { MetricsService } from './metrics.service.js';

@ApiTags('metrics')
@ApiCookieAuth()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('overview')
  @ApiOperation({ summary: 'Сводка метрик парка для «Обзора» (последние значения + спарклайны CPU)' })
  @ApiOkResponse({ type: OverviewMetricsResponseDto })
  overview(): Promise<OverviewMetricsResponseDto> {
    return this.metrics.overview();
  }

  @Get('servers/:id')
  @ApiOperation({ summary: 'Серии метрик сервера за диапазон (1h/24h/7d) из VictoriaMetrics' })
  @ApiOkResponse({ type: ServerMetricsResponseDto })
  server(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ServerMetricsQueryDto,
  ): Promise<ServerMetricsResponseDto> {
    return this.metrics.serverSeries(id, query.range);
  }
}
