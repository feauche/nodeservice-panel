import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { ServersModule } from '../servers/servers.module.js';
import { NodeActionsController } from './node-actions.controller.js';
import { NodeLayoutStore } from './node-layout.store.js';
import { DnsHostResolver, HOST_RESOLVER, NodeLinkService } from './node-link.service.js';
import { NodeMetricsController, NodeMetricsService } from './node-metrics.controller.js';
import { NodePreferencesStore } from './node-preferences.store.js';
import { NodesController } from './nodes.controller.js';
import { RemnaBillingProvidersController } from './remna-billing-providers.controller.js';
import { RemnaPermissionsService } from './remna-permissions.service.js';
import { RemnaProviderAssetsService } from './remna-provider-assets.service.js';
import { RemnaProviderCatalogController } from './remna-provider-catalog.controller.js';
import { RemnaProvidersController } from './remna-providers.controller.js';
import { RemnaProvidersService } from './remna-providers.service.js';
import { RemnawaveController } from './remnawave.controller.js';
import { RemnawaveService } from './remnawave.service.js';
import { HttpRemnawaveClient, REMNAWAVE_CLIENT } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { RemnawaveSyncJob } from './remnawave-sync.job.js';
import { RemnawaveTopologyService } from './remnawave-topology.service.js';
import { RemnawaveVpnProbeService } from './remnawave-vpn-probe.service.js';

/** J4: подключение к панели Remnawave, только чтение (домен + токен API с правами на чтение). */
@Module({
  imports: [AuditModule, BillingModule, ServersModule, NotificationsModule, ProvidersModule],
  controllers: [
    NodeMetricsController,
    RemnaBillingProvidersController,
    NodeActionsController,
    RemnawaveController,
    NodesController,
    RemnaProvidersController,
    RemnaProviderCatalogController,
  ],
  providers: [
    NodeMetricsService,
    RemnaProviderCatalogController,
    NodeLayoutStore,
    RemnaPermissionsService,
    RemnawaveSettingsStore,
    NodePreferencesStore,
    RemnaProvidersService,
    RemnaProviderAssetsService,
    RemnawaveService,
    RemnawaveSyncJob,
    RemnawaveVpnProbeService,
    RemnawaveTopologyService,
    NodeLinkService,
    { provide: REMNAWAVE_CLIENT, useClass: HttpRemnawaveClient },
    { provide: HOST_RESOLVER, useClass: DnsHostResolver },
  ],
  exports: [
    NodeMetricsService,
    RemnawaveSettingsStore,
    RemnawaveService,
    NodeLinkService,
    RemnawaveVpnProbeService,
    RemnawaveTopologyService,
  ],
})
export class RemnawaveModule {}
