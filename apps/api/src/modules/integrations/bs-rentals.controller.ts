import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { bsRentalTargetsInputSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { Audit } from '../audit/audit.decorator.js';
import { BsRentalsService } from './bs-rentals.service.js';

class TargetsDto extends createZodDto(bsRentalTargetsInputSchema) {}
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
  @Post('changes/:changeId/execute') @HttpCode(200) @Audit('integration.refreshed') execute(
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
