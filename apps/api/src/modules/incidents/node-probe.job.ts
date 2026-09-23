import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

import { ServersRepository } from '../servers/servers.repository.js';
import { IncidentRunnerService, NODE_PROBE } from './incident-runner.service.js';
import { IncidentsService } from './incidents.service.js';

/**
 * Зонд контейнера ноды: раз в 15 с по SSH от root спрашиваем `docker inspect` у каждого сервера
 * с рабочим SSH. Агент в песочнице контейнер видеть не может, поэтому источник — панель.
 * `true`/`false` → состояние (сменилось — инцидент судится сразу), `none` (контейнера нет) → не судим.
 */
export const PROBE_INTERVAL_MS = 15_000;

@Injectable()
export class NodeProbeJob {
  private readonly log = new Logger(NodeProbeJob.name);
  private busy = false;

  constructor(
    private readonly servers: ServersRepository,
    private readonly runner: IncidentRunnerService,
    private readonly incidents: IncidentsService,
  ) {}

  @Interval(PROBE_INTERVAL_MS)
  async tick(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = (await this.servers.list()).filter((r) => r.sshOk !== false);
      // По несколько серверов параллельно: у каждого свой SSH-коннект, ждать по очереди долго.
      const queue = [...rows];
      const worker = async () => {
        for (let row = queue.shift(); row; row = queue.shift()) {
          const probe = await this.runner.sshProbe(row.id, NODE_PROBE);
          await this.incidents.probeNodeState(
            row.id,
            probe === 'true' ? true : probe === 'false' ? false : undefined,
          );
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, worker));
    } catch (err) {
      this.log.warn(`зонд контейнера ноды: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
