import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { VM_METRIC_NAMES } from '@nodeservice/shared';

import { VmReaderService } from '../metrics/vm-reader.service.js';
import { ServersRepository } from '../servers/servers.repository.js';
import { IncidentsService } from './incidents.service.js';

/** Тик детекции инцидентов раз в 30 с: свежие метрики из VictoriaMetrics → правила. */
@Injectable()
export class IncidentsJob {
  private readonly log = new Logger(IncidentsJob.name);
  private busy = false;

  constructor(
    private readonly incidents: IncidentsService,
    private readonly vm: VmReaderService,
    private readonly servers: ServersRepository,
  ) {}

  @Interval(30_000)
  async tick(): Promise<void> {
    // В e2e джобы не тикают сами — тесты управляют состоянием напрямую (детерминизм).
    if (process.env.NODE_ENV === 'test') return;
    if (this.busy) return;
    this.busy = true;
    try {
      const rows = await this.servers.list();
      if (rows.length === 0) return;
      const sel = `{server_id=~"${rows.map((r) => r.id).join('|')}"}`;
      const [cpu, mem, disk] = await Promise.all([
        this.vm.query(`${VM_METRIC_NAMES.cpuPct}${sel}`),
        this.vm.query(`100 * ${VM_METRIC_NAMES.memUsedMb}${sel} / (${VM_METRIC_NAMES.memTotalMb}${sel} > 0)`),
        this.vm.query(
          `100 * ${VM_METRIC_NAMES.diskUsedMb}${sel} / (${VM_METRIC_NAMES.diskTotalMb}${sel} > 0)`,
        ),
      ]);
      await this.incidents.evaluate({
        cpu: this.byServer(cpu),
        mem: this.byServer(mem),
        disk: this.byServer(disk),
      });
    } catch (err) {
      this.log.warn(`Детекция инцидентов споткнулась: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private byServer(res: Array<{ labels: Record<string, string>; points: Array<[number, number]> }> | null) {
    const map = new Map<string, number>();
    for (const s of res ?? []) {
      const v = s.points.at(-1)?.[1];
      if (s.labels.server_id && v !== undefined && Number.isFinite(v)) map.set(s.labels.server_id, v);
    }
    return map;
  }
}
