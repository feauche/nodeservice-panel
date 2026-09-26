import { Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ServerDto } from '../servers/servers.dto.js';
import { FleetInventoryService } from './fleet-inventory.service.js';

@ApiTags('servers')
@ApiCookieAuth()
@Controller('servers')
export class FleetInventoryController {
  constructor(private readonly inventory: FleetInventoryService) {}

  @Post(':id/inventory')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Обновить снимок состояния сервера по SSH (контейнеры и слушающие порты) и вернуть сервер с расхождениями',
  })
  @ApiOkResponse({ type: ServerDto })
  refresh(@Param('id', ParseUUIDPipe) id: string): Promise<ServerDto> {
    return this.inventory.refresh(id);
  }
}
