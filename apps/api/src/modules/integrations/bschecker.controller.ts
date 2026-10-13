import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { bsProbeInputSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { Audit } from '../audit/audit.decorator.js';
import { BsCheckerService } from './bschecker.service.js';

class InputDto extends createZodDto(bsProbeInputSchema) {}
@Controller('integrations/bschecker')
export class BsCheckerController {
  constructor(private readonly bs: BsCheckerService) {}
  @Get('history') history() {
    return this.bs.history();
  }
  @Get('workspace') workspace() {
    return this.bs.workspace();
  }
  @Post('preview') @HttpCode(200) preview(@Body() body: InputDto) {
    return this.bs.preview(body);
  }
  @Get('runs/:id') get(@Param('id', ParseUUIDPipe) id: string) {
    return this.bs.get(id);
  }
  @Post('runs/:id/execute') @HttpCode(200) @Audit('integration.bs.check_started') execute(
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.bs.execute(id);
  }
}
