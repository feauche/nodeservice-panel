import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { CheckHostModule } from '../incidents/check-host.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { DnsIntegrationModule } from '../integrations/dns.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RemnawaveModule } from '../remnawave/remnawave.module.js';
import { SettingsModule } from '../settings/settings.module.js';
import { ReserveIpsController } from './reserve-ips.controller.js';
import { ReserveIpsService } from './reserve-ips.service.js';

/** Запасные IP ноды (0.111.0): проверка через Check-Host и переключение — Remnawave, Host, DNS. */
@Module({
  imports: [
    RemnawaveModule,
    CheckHostModule,
    SettingsModule,
    DnsIntegrationModule,
    IncidentsModule,
    AuditModule,
    NotificationsModule,
  ],
  controllers: [ReserveIpsController],
  providers: [ReserveIpsService],
  exports: [ReserveIpsService],
})
export class ReserveIpsModule {}
