import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { analysisAskRequestSchema, incidentSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { IncidentAnalysisService } from './incident-analysis.service.js';

export class AnalysisIncidentDto extends createZodDto(incidentSchema) {}
export class AnalysisAskRequestDto extends createZodDto(analysisAskRequestSchema) {}

@ApiTags('incidents')
@ApiCookieAuth()
@Controller('incidents')
export class IncidentAnalysisController {
  constructor(private readonly analysis: IncidentAnalysisService) {}

  @Post(':id/analysis')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Разобрать инцидент Джарвисом: работа идёт в фоне, ход виден в самом инциденте',
  })
  @ApiOkResponse({ type: AnalysisIncidentDto })
  start(@Param('id', ParseUUIDPipe) id: string): Promise<AnalysisIncidentDto> {
    return this.analysis.start(id);
  }

  @Post(':id/analysis/ask')
  @HttpCode(200)
  @ApiOperation({ summary: 'Уточняющий вопрос по готовому разбору инцидента' })
  @ApiOkResponse({ type: AnalysisIncidentDto })
  ask(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AnalysisAskRequestDto,
  ): Promise<AnalysisIncidentDto> {
    return this.analysis.ask(id, body.question);
  }
}
