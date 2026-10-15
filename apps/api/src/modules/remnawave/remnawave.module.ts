import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CheckHostModule } from '../incidents/check-host.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { ProvidersModule } from '../providers/providers.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { DnsHostResolver, HOST_RESOLVER, HostAddressesService } from './host-addresses.service.js';
import { NodeActionsController } from './node-actions.controller.js';
import { NodeLayoutStore } from './node-layout.store.js';
import { NodeMaintenanceStore } from './node-maintenance.store.js';
import { NodePreferencesStore } from './node-preferences.store.js';
import { NodeRatesStore } from './node-rates.store.js';
import { NodeTcpHistoryService } from './node-tcp-history.service.js';
import { NodesController } from './nodes.controller.js';
import { RemnaBillingProvidersController } from './remna-billing-providers.controller.js';
import { RemnaPermissionsService } from './remna-permissions.service.js';
import { RemnaProviderAssetsService } from './remna-provider-assets.service.js';
import { RemnaProviderCatalogController } from './remna-provider-catalog.controller.js';
import { RemnaProvidersController } from './remna-providers.controller.js';
import { RemnaProvidersService } from './remna-providers.service.js';
import { RemnawaveService } from './remnawave.service.js';
import { HttpRemnawaveClient, REMNAWAVE_CLIENT } from './remnawave-client.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';
import { RemnawaveTopologyService } from './remnawave-topology.service.js';

/** J4: подключение к панели Remnawave, только чтение (домен + токен API с правами на чтение). */
@Module({
  imports: [
    CheckHostModule,
    SettingsModule,
    AuditModule,
    BillingModule,
    NotificationsModule,
    ProvidersModule,
  ],
  controllers: [
    RemnaBillingProvidersController,
    NodeActionsController,
    NodesController,
    RemnaProvidersController,
    RemnaProviderCatalogController,
  ],
  providers: [
    NodeTcpHistoryService,
    RemnaProviderCatalogController,
    NodeLayoutStore,
    RemnaPermissionsService,
    RemnawaveSettingsStore,
    NodePreferencesStore,
    NodeMaintenanceStore,
    NodeRatesStore,
    RemnaProvidersService,
    RemnaProviderAssetsService,
    RemnawaveService,
    RemnawaveTopologyService,
    HostAddressesService,
    { provide: REMNAWAVE_CLIENT, useClass: HttpRemnawaveClient },
    { provide: HOST_RESOLVER, useClass: DnsHostResolver },
  ],
  exports: [
    NodeMaintenanceStore,
    NodePreferencesStore,
    NodeRatesStore,
    RemnaPermissionsService,
    RemnawaveSettingsStore,
    RemnawaveService,
    RemnawaveTopologyService,
  ],
})
export class RemnawaveModule {}
