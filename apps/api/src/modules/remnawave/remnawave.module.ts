import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { DnsHostResolver, HOST_RESOLVER, NodeLinkService } from './node-link.service.js';
import { RemnawaveController } from './remnawave.controller.js';
import { RemnawaveService } from './remnawave.service.js';
import { HttpRemnawaveClient, REMNAWAVE_CLIENT } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { RemnawaveSyncJob } from './remnawave-sync.job.js';
import { RemnawaveTopologyService } from './remnawave-topology.service.js';
import { RemnawaveVpnProbeService } from './remnawave-vpn-probe.service.js';

/** J4: подключение к панели Remnawave, только чтение (домен + токен API с правами на чтение). */
@Module({
  imports: [AuditModule, ServersModule, NotificationsModule],
  controllers: [RemnawaveController],
  providers: [
    RemnawaveSettingsStore,
    RemnawaveService,
    RemnawaveSyncJob,
    RemnawaveVpnProbeService,
    RemnawaveTopologyService,
    NodeLinkService,
    { provide: REMNAWAVE_CLIENT, useClass: HttpRemnawaveClient },
    { provide: HOST_RESOLVER, useClass: DnsHostResolver },
  ],
  exports: [RemnawaveService, NodeLinkService, RemnawaveVpnProbeService, RemnawaveTopologyService],
})
export class RemnawaveModule {}
