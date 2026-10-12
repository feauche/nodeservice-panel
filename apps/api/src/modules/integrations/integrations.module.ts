import { Module } from '@nestjs/common';
import { BsCheckerModule } from './bschecker.module.js';
import { DnsIntegrationModule } from './dns.module.js';
import { DpiCheckerModule } from './dpi.module.js';
import { IntegrationConnectionsModule } from './integration-connections.module.js';
import { IntegrationsController } from './integrations.controller.js';
import { IntegrationWorkspaceController } from './workspace.controller.js';
/** Composition root. Подключения общие; проверки, расписания и кэш принадлежат модулям провайдеров. */
@Module({
  imports: [IntegrationConnectionsModule, BsCheckerModule, DpiCheckerModule, DnsIntegrationModule],
  controllers: [IntegrationsController, IntegrationWorkspaceController],
})
export class IntegrationsModule {}
