import { Injectable } from '@nestjs/common';
import { VM_METRIC_NAMES } from '@nodeservice/shared';

import { VmReaderService } from '../metrics/vm-reader.service.js';

export interface LatestMetrics {
  cpu: Map<string, number>;
  mem: Map<string, number>;
  disk: Map<string, number>;
}

/** Свежие значения CPU/память/диск по серверам из VictoriaMetrics — для Ассистента. */
@Injectable()
export class IncidentMetricsService {
  constructor(private readonly vm: VmReaderService) {}

  async latest(serverIds: string[]): Promise<LatestMetrics> {
    if (serverIds.length === 0) return { cpu: new Map(), mem: new Map(), disk: new Map() };
    const sel = `{server_id=~"${serverIds.join('|')}"}`;
    const [cpu, mem, disk] = await Promise.all([
      this.vm.query(`${VM_METRIC_NAMES.cpuPct}${sel}`),
      this.vm.query(`100 * ${VM_METRIC_NAMES.memUsedMb}${sel} / (${VM_METRIC_NAMES.memTotalMb}${sel} > 0)`),
      this.vm.query(`100 * ${VM_METRIC_NAMES.diskUsedMb}${sel} / (${VM_METRIC_NAMES.diskTotalMb}${sel} > 0)`),
    ]);
    return {
      cpu: this.byServer(cpu),
      mem: this.byServer(mem),
      disk: this.byServer(disk),
    };
  }

  private byServer(
    res: Array<{ labels: Record<string, string>; points: Array<[number, number]> }> | null,
  ): Map<string, number> {
    const map = new Map<string, number>();
    for (const s of res ?? []) {
      const v = s.points.at(-1)?.[1];
      if (s.labels.server_id && v !== undefined && Number.isFinite(v)) map.set(s.labels.server_id, v);
    }
    return map;
  }
}
