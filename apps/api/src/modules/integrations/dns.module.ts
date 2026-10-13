import { Module } from '@nestjs/common';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { DnsService } from './dns.service.js';
import { IntegrationConnectionsModule } from './integration-connections.module.js';
@Module({
  imports: [IntegrationConnectionsModule, RemnawaveModule, IncidentsModule],
  controllers: [],
  providers: [DnsService],
  exports: [DnsService],
})
export class DnsIntegrationModule {}
