import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { integrationConnectionSchema, integrationProviderSchema } from '@nodeservice/shared';
import { createZodDto } from 'nestjs-zod';
import { Audit } from '../audit/audit.decorator.js';
import { IntegrationsService } from './integrations.service.js';

class ConnectionDto extends createZodDto(integrationConnectionSchema) {}
function provider(raw: string) {
  const result = integrationProviderSchema.safeParse(raw);
  if (!result.success) throw new BadRequestException('Неизвестная интеграция.');
  return result.data;
}
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}
  @Get() list() {
    return this.service.list();
  }
  @Audit('integration.connected')
  @Post(':provider/connect')
  @HttpCode(200)
  connect(@Param('provider') raw: string, @Body() body: ConnectionDto) {
    return this.service.connect(provider(raw), body);
  }
  @Audit('integration.refreshed')
  @Post(':provider/refresh')
  @HttpCode(200)
  refresh(@Param('provider') raw: string) {
    return this.service.refresh(provider(raw));
  }
  @Audit('integration.disconnected')
  @Delete(':provider')
  @HttpCode(204)
  disconnect(@Param('provider') raw: string) {
    return this.service.disconnect(provider(raw));
  }
}
