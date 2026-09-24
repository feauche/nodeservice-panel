import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type ActionKey,
  actionKeySchema,
  incidentPolicyResponseSchema,
  incidentPolicyUpdateSchema,
  incidentSchema,
  incidentsListQuerySchema,
  incidentsListResponseSchema,
  resolveIncidentRequestSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { Audit } from '../audit/audit.decorator.js';
import { IncidentsService } from './incidents.service.js';

export class IncidentsListQueryDto extends createZodDto(incidentsListQuerySchema) {}
export class IncidentsListResponseDto extends createZodDto(incidentsListResponseSchema) {}
export class IncidentDto extends createZodDto(incidentSchema) {}
export class IncidentPolicyResponseDto extends createZodDto(incidentPolicyResponseSchema) {}
export class IncidentPolicyUpdateDto extends createZodDto(incidentPolicyUpdateSchema) {}

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

  // Статический маршрут раньше `:id`, иначе ParseUUIDPipe отвергнет «policy».
  @Get('policy')
  @ApiOperation({ summary: 'Автопочинка: политика по сигналам, цепочки шагов, статистика' })
  @ApiOkResponse({ type: IncidentPolicyResponseDto })
  policy(): Promise<IncidentPolicyResponseDto> {
    return this.incidents.policy();
  }

  @Patch('policy')
  @Audit('settings.incidents.updated', {
    target: { type: 'settings', id: 'incidents', display: 'Инциденты' },
  })
  @ApiOperation({ summary: 'Автопочинка: общий тумблер, политика по сигналам, пауза' })
  @ApiOkResponse({ type: IncidentPolicyResponseDto })
  updatePolicy(@Body() body: IncidentPolicyUpdateDto): Promise<IncidentPolicyResponseDto> {
    return this.incidents.updatePolicy(body);
  }

  @Delete('resolved')
  @HttpCode(200)
  @ApiOperation({ summary: 'Удалить все решённые инциденты' })
  deleteResolved(): Promise<{ deleted: number }> {
    return this.incidents.deleteResolved();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Один инцидент с хронологией и попытками' })
  @ApiOkResponse({ type: IncidentDto })
  get(@Param('id', ParseUUIDPipe) id: string): Promise<IncidentDto> {
    return this.incidents.get(id);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Удалить инцидент из истории' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.incidents.delete(id);
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
  resolve(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<IncidentDto> {
    // Тело необязательно: без него — обычное закрытие.
    return this.incidents.resolveManual(id, resolveIncidentRequestSchema.parse(body ?? {}));
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
