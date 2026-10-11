import { Body, Controller, Get, Param, ParseUUIDPipe, Patch } from '@nestjs/common';
import { remnaProviderUpdateSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { Audit } from '../audit/audit.decorator.js';
import { RemnaProvidersService } from './remna-providers.service.js';

class UpdateProviderDto extends createZodDto(remnaProviderUpdateSchema) {}
@Controller('nodes/providers')
export class RemnaProvidersController {
  constructor(private readonly providers: RemnaProvidersService) {}
  @Get() async list() {
    return { providers: await this.providers.list() };
  }
  @Patch(':uuid')
  @Audit('remnawave.provider_updated')
  update(@Param('uuid', new ParseUUIDPipe()) uuid: string, @Body() body: UpdateProviderDto) {
    return this.providers.update(uuid, body);
  }
}
