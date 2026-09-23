import { Injectable } from '@nestjs/common';
import { VM_METRIC_NAMES } from '@nodeservice/shared';

import { VmReaderService } from '../metrics/vm-reader.service.js';

export interface LatestMetrics {
  cpu: Map<string, number>;
  mem: Map<string, number>;
  disk: Map<string, number>;
}
export interface ServerMetrics {
  cpu?: number | undefined;
  mem?: number | undefined;
  disk?: number | undefined;
  at: number;
}

/**
 * Свежие значения CPU/память/диск по серверам из VictoriaMetrics — для детекции и пост-проверок.
 * В e2e VictoriaMetrics нет: тесты кладут значения через `remember()`/`setForTest()`.
 */
@Injectable()
export class IncidentMetricsService {
  private readonly lastKnown = new Map<string, ServerMetrics>();

  constructor(private readonly vm: VmReaderService) {}

  async latest(serverIds: string[]): Promise<LatestMetrics> {
    if (serverIds.length === 0) return { cpu: new Map(), mem: new Map(), disk: new Map() };
    const sel = `{server_id=~"${serverIds.join('|')}"}`;
    const [cpu, mem, disk] = await Promise.all([
      this.vm.query(`${VM_METRIC_NAMES.cpuPct}${sel}`),
      this.vm.query(`100 * ${VM_METRIC_NAMES.memUsedMb}${sel} / (${VM_METRIC_NAMES.memTotalMb}${sel} > 0)`),
      this.vm.query(`100 * ${VM_METRIC_NAMES.diskUsedMb}${sel} / (${VM_METRIC_NAMES.diskTotalMb}${sel} > 0)`),
    ]);
    const out = { cpu: this.byServer(cpu), mem: this.byServer(mem), disk: this.byServer(disk) };
    this.remember(out);
    return out;
  }

  /** Последнее значение по одному серверу: в проде — свежий запрос, в тестах — что запомнили. */
  async latestFor(serverId: string): Promise<ServerMetrics | undefined> {
    if (process.env.NODE_ENV === 'test') return this.lastKnown.get(serverId);
    const m = await this.latest([serverId]);
    return {
      cpu: m.cpu.get(serverId),
      mem: m.mem.get(serverId),
      disk: m.disk.get(serverId),
      at: Date.now(),
    };
  }

  remember(m: LatestMetrics): void {
    const ids = new Set([...m.cpu.keys(), ...m.mem.keys(), ...m.disk.keys()]);
    for (const id of ids)
      this.lastKnown.set(id, {
        cpu: m.cpu.get(id),
        mem: m.mem.get(id),
        disk: m.disk.get(id),
        at: Date.now(),
      });
  }

  setForTest(serverId: string, values: Omit<ServerMetrics, 'at'>): void {
    this.lastKnown.set(serverId, { ...values, at: Date.now() });
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
