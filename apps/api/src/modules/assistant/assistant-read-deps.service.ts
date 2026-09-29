import { Injectable } from '@nestjs/common';
import type { AssistantPermissions } from '@nodeservice/shared';

import { BillingService } from '../billing/billing.service.js';
import { FleetStatsService } from '../fleet-stats/fleet-stats.service.js';
import { IncidentMetricsService } from '../incidents/incident-metrics.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { VmReaderService } from '../metrics/vm-reader.service.js';
import { ProvidersService } from '../providers/providers.service.js';
import { ServerChecksService } from '../server-checks/server-checks.service.js';
import { ServersService } from '../servers/servers.service.js';
import type { ReadDeps } from './assistant.read-tools.js';
import { FleetProbeService } from './fleet-probe.service.js';

/** Зависимости инструментов чтения одним местом: их нужно и разбору инцидента, и подсказкам к терминалу. */
@Injectable()
export class ReadDepsService {
  constructor(
    private readonly servers: ServersService,
    private readonly incidents: IncidentsService,
    private readonly metrics: VmReaderService,
    private readonly incidentMetrics: IncidentMetricsService,
    private readonly providers: ProvidersService,
    private readonly maintenance: MaintenanceService,
    private readonly checks: ServerChecksService,
    private readonly probe: FleetProbeService,
    private readonly billing: BillingService,
    private readonly fleetStats: FleetStatsService,
  ) {}

  get(permissions: AssistantPermissions): ReadDeps {
    return {
      servers: this.servers,
      incidents: this.incidents,
      metrics: this.metrics,
      incidentMetrics: this.incidentMetrics,
      providers: this.providers,
      maintenance: this.maintenance,
      checks: this.checks,
      probe: this.probe,
      billing: this.billing,
      fleetStats: this.fleetStats,
      permissions,
    };
  }
}
