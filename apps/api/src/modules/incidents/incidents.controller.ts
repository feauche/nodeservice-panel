import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  autofixRunRequestSchema,
  incidentSchema,
  incidentsListQuerySchema,
  incidentsListResponseSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { StepUpGuard } from '../security/step-up.guard.js';
import { IncidentsService } from './incidents.service.js';

export class IncidentsListQueryDto extends createZodDto(incidentsListQuerySchema) {}
export class IncidentsListResponseDto extends createZodDto(incidentsListResponseSchema) {}
export class IncidentDto extends createZodDto(incidentSchema) {}
export class AutofixRunRequestDto extends createZodDto(autofixRunRequestSchema) {}

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

  @Get(':id')
  @ApiOperation({ summary: 'Один инцидент с таймлайном' })
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

  @Post(':id/autofix')
  @HttpCode(200)
  @UseGuards(StepUpGuard)
  @ApiOperation({ summary: 'Запустить пресет автопочинки по SSH (step-up)' })
  @ApiOkResponse({ type: IncidentDto })
  autofix(@Param('id', ParseUUIDPipe) id: string, @Body() body: AutofixRunRequestDto): Promise<IncidentDto> {
    return this.incidents.runAutofix(id, body.preset, 'manual');
  }
}
