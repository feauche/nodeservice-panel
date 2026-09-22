import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiAcceptedResponse, ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type MaintenanceRun,
  type MaintenanceRunsResponse,
  type MaintenanceState,
  maintenanceRunSchema,
  maintenanceRunsResponseSchema,
  maintenanceStateSchema,
  startMaintenanceRequestSchema,
} from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';

import { MaintenanceService } from './maintenance.service.js';

export class MaintenanceStateDto extends createZodDto(maintenanceStateSchema) {}
export class MaintenanceRunDto extends createZodDto(maintenanceRunSchema) {}
export class MaintenanceRunsResponseDto extends createZodDto(maintenanceRunsResponseSchema) {}
export class StartMaintenanceRequestDto extends createZodDto(startMaintenanceRequestSchema) {}

/** Обслуживание сервера: чек-лист, запуск действий, история запусков. Без step-up, как терминал. */
@ApiTags('maintenance')
@ApiCookieAuth()
@Controller('servers/:id/maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get()
  @ApiOperation({ summary: 'Состояние обслуживания: чек-лист, идущий и последний запуск' })
  @ApiOkResponse({ type: MaintenanceStateDto })
  state(@Param('id', ParseUUIDPipe) id: string): Promise<MaintenanceState> {
    return this.maintenance.state(id);
  }

  @Post('runs')
  @HttpCode(202)
  @ApiOperation({ summary: 'Запустить проверку или действие (409, если на сервере уже что-то идёт)' })
  @ApiAcceptedResponse({ type: MaintenanceRunDto })
  start(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StartMaintenanceRequestDto,
  ): Promise<MaintenanceRun> {
    return this.maintenance.start(id, body.kind);
  }

  @Get('runs')
  @ApiOperation({ summary: 'История запусков обслуживания (без логов)' })
  @ApiOkResponse({ type: MaintenanceRunsResponseDto })
  runs(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('limit') limitRaw?: string,
  ): Promise<MaintenanceRunsResponse> {
    const n = Number(limitRaw);
    return this.maintenance.runs(id, Number.isInteger(n) && n > 0 ? n : 20);
  }
}
