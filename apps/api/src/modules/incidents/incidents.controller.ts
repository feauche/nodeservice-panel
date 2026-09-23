import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type ActionKey,
  actionKeySchema,
  incidentActionsResponseSchema,
  incidentActionsUpdateSchema,
  incidentSchema,
  incidentsListQuerySchema,
  incidentsListResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { Audit } from '../audit/audit.decorator.js';
import { IncidentsService } from './incidents.service.js';

export class IncidentsListQueryDto extends createZodDto(incidentsListQuerySchema) {}
export class IncidentsListResponseDto extends createZodDto(incidentsListResponseSchema) {}
export class IncidentDto extends createZodDto(incidentSchema) {}
export class IncidentActionsResponseDto extends createZodDto(incidentActionsResponseSchema) {}
export class IncidentActionsUpdateDto extends createZodDto(incidentActionsUpdateSchema) {}

@ApiTags('incidents')
@ApiCookieAuth()
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get()
  @ApiOperation({ summary: 'Список инцидентов (all/open/resolved) со счётчиками' })
  @ApiOkResponse({ type: IncidentsListResponseDto })
  list(@Query() query: IncidentsListQueryDto): Promise<IncidentsListResponseDto> {
    return this.incidents.list(query.status);
  }

  // Статический маршрут раньше `:id`, иначе ParseUUIDPipe отвергнет «actions».
  @Get('actions')
  @ApiOperation({ summary: 'Реестр действий автопочинки: уровни, тумблеры, статистика' })
  @ApiOkResponse({ type: IncidentActionsResponseDto })
  actions(): Promise<IncidentActionsResponseDto> {
    return this.incidents.actions();
  }

  @Patch('actions')
  @Audit('settings.incidents.updated', {
    target: { type: 'settings', id: 'incidents', display: 'Инциденты' },
  })
  @ApiOperation({ summary: 'Тумблеры автопочинки: общий и по T1-действиям' })
  @ApiOkResponse({ type: IncidentActionsResponseDto })
  updateActions(@Body() body: IncidentActionsUpdateDto): Promise<IncidentActionsResponseDto> {
    return this.incidents.updateActions(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Один инцидент с хронологией и попытками' })
  @ApiOkResponse({ type: IncidentDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentDto> {
    return this.incidents.get(id);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @ApiOperation({ summary: 'Взять инцидент в работу' })
  @ApiOkResponse({ type: IncidentDto })
  acknowledge(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentDto> {
    return this.incidents.acknowledge(id);
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @ApiOperation({ summary: 'Закрыть инцидент вручную' })
  @ApiOkResponse({ type: IncidentDto })
  resolve(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentDto> {
    return this.incidents.resolveManual(id);
  }

  @Post(':id/actions/:action/run')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Запустить действие реестра (T1/T2): попытка идёт в фоне, инцидент перечитывается',
  })
  @ApiOkResponse({ type: IncidentDto })
  run(@Param('id', ParseUUIDPipe) id: string, @Param('action') action: string): Promise<IncidentDto> {
    return this.incidents.runAction(id, actionKeySchema.parse(action) as ActionKey);
  }
}
