import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { MaintenanceModule } from '../maintenance/maintenance.module.js';
import { MetricsModule } from '../metrics/metrics.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantRepository } from './assistant.repository.js';
import { AssistantService } from './assistant.service.js';
import { AssistantSettingsModule } from './assistant-settings.module.js';
import { IncidentAnalysisController } from './incident-analysis.controller.js';
import { IncidentAnalysisService } from './incident-analysis.service.js';
import { KbReviewService } from './kb-review.service.js';
import { LLM_PROVIDER } from './llm.provider.js';
import { ZvenoProvider } from './zveno.provider.js';

/** Этап 9: AI-ассистент. Провайдер LLM за токеном — в тестах подменяется фейком. */
@Module({
  imports: [
    ServersModule,
    IncidentsModule,
    KnowledgeModule,
    MetricsModule,
    MaintenanceModule,
    ProvidersModule,
    AuditModule,
    AssistantSettingsModule,
    SettingsModule,
  ],
  controllers: [AssistantController, IncidentAnalysisController],
  providers: [
    AssistantService,
    IncidentAnalysisService,
    AssistantRepository,
    KbReviewService,
    { provide: LLM_PROVIDER, useClass: ZvenoProvider },
  ],
})
export class AssistantModule {}
