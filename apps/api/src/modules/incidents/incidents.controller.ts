import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  incidentPolicyResponseSchema,
  incidentPolicyUpdateSchema,
  incidentSchema,
  incidentsListQuerySchema,
  incidentsListResponseSchema,
  incidentWeekStatsSchema,
  resolveIncidentRequestSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { IncidentsService } from './incidents.service.js';

export class IncidentsListQueryDto extends createZodDto(incidentsListQuerySchema) {}
export class IncidentsListResponseDto extends createZodDto(incidentsListResponseSchema) {}
export class IncidentDto extends createZodDto(incidentSchema) {}
export class IncidentWeekStatsDto extends createZodDto(incidentWeekStatsSchema) {}
export class IncidentPolicyResponseDto extends createZodDto(incidentPolicyResponseSchema) {}
export class IncidentPolicyUpdateDto extends createZodDto(incidentPolicyUpdateSchema) {}

@ApiTags('incidents')
@ApiCookieAuth()
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @ApiOperation({ summary: 'Список событий (all/open/resolved) со счётчиками' })
  @ApiOkResponse({ type: IncidentsListResponseDto })
  list(@Query() query: IncidentsListQueryDto): Promise<IncidentsListResponseDto> {
    return this.incidents.list(query.status, {
      openedFrom: query.openedFrom,
      page: query.page,
      pageSize: query.pageSize,
      offset: query.offset,
    });
  }

  @Get('week-stats')
  @ApiOperation({ summary: 'Итог за 7 дней для полосы над реестром' })
  @ApiOkResponse({ type: IncidentWeekStatsDto })
  weekStats(): Promise<IncidentWeekStatsDto> {
    return this.incidents.weekStats();
  }

  @Delete('resolved')
  @HttpCode(200)
  @ApiOperation({ summary: 'Удалить все завершённые события' })
  deleteResolved(): Promise<{ deleted: number }> {
    return this.incidents.deleteResolved();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Одно событие с хронологией и попытками' })
  @ApiOkResponse({ type: IncidentDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentDto> {
    return this.incidents.get(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Удалить событие из истории' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.incidents.delete(id);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Взять событие в работу' })
  @ApiOkResponse({ type: IncidentDto })
  acknowledge(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentDto> {
    return this.incidents.acknowledge(id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Завершить событие вручную' })
  @ApiOkResponse({ type: IncidentDto })
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<IncidentDto> {
    // Тело необязательно; старый признак «не следить за нодой на сервере» принимается и ничего не меняет.
    resolveIncidentRequestSchema.parse(body ?? {});
    return this.incidents.resolveManual(id);
  }
}
