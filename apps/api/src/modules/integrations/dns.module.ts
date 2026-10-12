import { Module } from '@nestjs/common';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { DnsService } from './dns.service.js';
import { IntegrationConnectionsModule } from './integration-connections.module.js';
@Module({
  imports: [IntegrationConnectionsModule, RemnawaveModule],
  controllers: [],
  providers: [DnsService],
  exports: [DnsService],
})
export class DnsIntegrationModule {}
