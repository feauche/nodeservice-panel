import { Module } from '@nestjs/common';
import { IntegrationsService } from './integrations.service.js';
@Module({ providers: [IntegrationsService], exports: [IntegrationsService] })
export class IntegrationConnectionsModule {}
