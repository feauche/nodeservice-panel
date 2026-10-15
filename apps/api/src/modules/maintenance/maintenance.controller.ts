import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { nodeMaintenanceStartSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { Audit } from '../audit/audit.decorator.js';
import { NodeMaintenanceService } from './maintenance.service.js';

class StartDto extends createZodDto(nodeMaintenanceStartSchema) {}

/** Обслуживание ноды (0.106.0): включить, продлить на час, закончить; какие Host скроются. */
@ApiTags('nodes')
@ApiCookieAuth()
@Controller('nodes/:uuid/maintenance')
export class NodeMaintenanceController {
  constructor(private readonly maintenance: NodeMaintenanceService) {}

  @Get('hosts')
  hosts(@Param('uuid', new ParseUUIDPipe()) uuid: string) {
    return this.maintenance.hostsPreview(uuid);
  }

  @Audit('incident.node_maintenance.start')
  @Put()
  start(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Body() body: StartDto) {
    return this.maintenance.start(uuid, body);
  }

  @Audit('incident.node_maintenance.extend')
  @Post('extend')
  @HttpCode(200)
  extend(@Param('uuid', new ParseUUIDPipe()) uuid: string) {
    return this.maintenance.extend(uuid);
  }

  @Audit('incident.node_maintenance.end')
  @Delete()
  end(@Param('uuid', new ParseUUIDPipe()) uuid: string) {
    return this.maintenance.end(uuid);
  }
}
