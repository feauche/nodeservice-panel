import { Injectable } from '@nestjs/common';

import { IncidentMetricsService } from '../incidents/incident-metrics.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { MaintenanceService } from '../maintenance/maintenance.service.js';
import { VmReaderService } from '../metrics/vm-reader.service.js';
import { ProvidersService } from '../providers/providers.service.js';
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
    private readonly probe: FleetProbeService,
  ) {}

  get(): ReadDeps {
    return {
      servers: this.servers,
      incidents: this.incidents,
      metrics: this.metrics,
      incidentMetrics: this.incidentMetrics,
      providers: this.providers,
      maintenance: this.maintenance,
      probe: this.probe,
    };
  }
}
