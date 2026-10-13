import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { bsRentalTargetsInputSchema, bsWsExitsInputSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { Audit } from '../audit/audit.decorator.js';
import { BsRentalsService } from './bs-rentals.service.js';

class TargetsDto extends createZodDto(bsRentalTargetsInputSchema) {}
class ExitsDto extends createZodDto(bsWsExitsInputSchema) {}
@Controller('integrations/bschecker/rentals')
export class BsRentalsController {
  constructor(private readonly rentals: BsRentalsService) {}
  @Get() list() {
    return this.rentals.list();
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.rentals.get(id);
  }
  @Post(':id/changes') @HttpCode(200) prepare(@Param('id') id: string, @Body() body: TargetsDto) {
    return this.rentals.prepare(id, body.targets);
  }
  @Post('changes/:changeId/execute') @HttpCode(200) @Audit('integration.bs.targets_changed') execute(
    @Param('changeId', ParseUUIDPipe) id: string,
  ) {
    return this.rentals.execute(id);
  }
  @Get(':id/check/:checkId') checkResult(@Param('id') id: string, @Param('checkId') checkId: string) {
    return this.rentals.checkResult(id, checkId);
  }
  @Post(':id/check') @HttpCode(200) check(@Param('id') id: string) {
    return this.rentals.check(id);
  }
}

/** Точки входа WebSocket BS Checker (/v1/ws): список, настройки подключения и смена серверов. */
@Controller('integrations/bschecker/ws')
export class BsWsController {
  constructor(private readonly rentals: BsRentalsService) {}
  @Get() list() {
    return this.rentals.wsList();
  }
  @Get(':id') get(@Param('id') id: string) {
    return this.rentals.wsGet(id);
  }
  /** Секреты точки — не кэшируются и попадают в «Журнал». */
  @Get(':id/connect')
  @Header('Cache-Control', 'no-store')
  @Audit('integration.bs.ws_connect_viewed')
  connect(@Param('id') id: string) {
    return this.rentals.wsConnect(id);
  }
  @Post(':id/changes') @HttpCode(200) prepare(@Param('id') id: string, @Body() body: ExitsDto) {
    return this.rentals.wsPrepare(id, body);
  }
  @Post('changes/:changeId/execute') @HttpCode(200) @Audit('integration.bs.ws_exits_changed') execute(
    @Param('changeId', ParseUUIDPipe) id: string,
  ) {
    return this.rentals.wsExecute(id);
  }
}
