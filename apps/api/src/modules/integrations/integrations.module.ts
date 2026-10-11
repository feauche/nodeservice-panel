import { Module } from '@nestjs/common';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { DnsService } from './dns.service.js';
import { DpiService } from './dpi.service.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { IntegrationWorkspaceController } from './workspace.controller.js';
@Module({
  imports: [RemnawaveModule],
  controllers: [IntegrationsController, IntegrationWorkspaceController],
  providers: [IntegrationsService, DpiService, DnsService],
})
export class IntegrationsModule {}
