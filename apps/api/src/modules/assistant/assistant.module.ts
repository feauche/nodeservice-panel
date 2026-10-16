import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BackupsModule } from '../backups/backups.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { BsCheckerModule } from '../integrations/bschecker.module.js';
import { DnsIntegrationModule } from '../integrations/dns.module.js';
import { DpiCheckerModule } from '../integrations/dpi.module.js';
import { IntegrationConnectionsModule } from '../integrations/integration-connections.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { NodeMetricsModule } from '../node-metrics/node-metrics.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { ScenariosModule } from '../scenarios/scenarios.module.js';
import { SecurityModule } from '../security/security.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantPanelReader } from './assistant.panel-reader.js';
import { AssistantRepository } from './assistant.repository.js';
import { AssistantService } from './assistant.service.js';
import { AssistantSettingsModule } from './assistant-settings.module.js';
import { KbReviewService } from './kb-review.service.js';
import { LLM_PROVIDER } from './llm.provider.js';
import { ZvenoProvider } from './zveno.provider.js';

/** Ассистент: читает панель и Remnawave, пишет только в базу знаний. Провайдер LLM за токеном — в тестах подменяется фейком. */
@Module({
  imports: [
    NodeMetricsModule,
    IncidentsModule,
    IntegrationConnectionsModule,
    KnowledgeModule,
    BillingModule,
    BackupsModule,
    RemnawaveModule,
    AuditModule,
    AssistantSettingsModule,
    SettingsModule,
    // Разделы панели, которые Ассистент читает (только чтение): сценарии, интеграции, Telegram, вход.
    ScenariosModule,
    DpiCheckerModule,
    DnsIntegrationModule,
    BsCheckerModule,
    NotificationsModule,
    SecurityModule,
  ],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    AssistantRepository,
    AssistantPanelReader,
    KbReviewService,
    { provide: LLM_PROVIDER, useClass: ZvenoProvider },
  ],
})
export class AssistantModule {}
