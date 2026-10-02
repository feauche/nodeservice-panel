import { Module } from '@nestjs/common';

import { ServersModule } from '../servers/servers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { AgentController } from './agent.controller.js';
import { AgentGateway } from './agent.gateway.js';
import { AgentService } from './agent.service.js';
import { AgentOfflineJob } from './agent-offline.job.js';
import { AgentPulseLimiter } from './agent-pulse.limiter.js';
import { VmWriterService } from './vm.service.js';

/** Этап 5: энроллмент, WebSocket-шлюз, метрики → VictoriaMetrics, offline-детект. */
@Module({
  imports: [ServersModule, SettingsModule],
  controllers: [AgentController],
  providers: [AgentService, AgentGateway, AgentPulseLimiter, VmWriterService, AgentOfflineJob],
  exports: [AgentGateway],
})
export class AgentModule {}
