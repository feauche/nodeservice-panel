import { Injectable } from '@nestjs/common';
import {
  METRIC_RANGES,
  type MetricPoint,
  type MetricRange,
  type OverviewMetricsResponse,
  type OverviewServerMetrics,
  SERVER_METRIC_KEYS,
  type ServerMetricsResponse,
  VM_METRIC_NAMES,
} from '@nodeservice/shared';

import { ServersRepository } from '../servers/servers.repository.js';
import { type VmMatrixSeries, VmReaderService } from './vm-reader.service.js';

const SPARK_SECONDS = 900;
const SPARK_STEP = 30;

/** Метрики для страниц: серии per-server и сводка «Обзора». Пустые данные — норма, а не 500. */
@Injectable()
export class MetricsService {
  constructor(
    private readonly vm: VmReaderService,
    private readonly servers: ServersRepository,
  ) {}

  async serverSeries(serverId: string, range: MetricRange): Promise<ServerMetricsResponse> {
    const { seconds, stepSeconds } = METRIC_RANGES[range];
    const end = Math.floor(Date.now() / 1000);
    const start = end - seconds;
    const series = {} as ServerMetricsResponse['series'];
    let vmOk = true;
    for (const key of SERVER_METRIC_KEYS) {
      const res = await this.vm.queryRange(
        `${VM_METRIC_NAMES[key]}{server_id="${serverId}"}`,
        start,
        end,
        stepSeconds,
      );
      if (res === null) {
        vmOk = false;
        series[key] = [];
        continue;
      }
      series[key] = toPoints(res[0]);
    }
    return { range, stepSeconds, vmOk, series };
  }

  async overview(): Promise<OverviewMetricsResponse> {
    const rows = await this.servers.list();
    if (rows.length === 0)
      return { vmOk: true, servers: [], fleet: { cpuAvgSpark: [], trafficSpark: [], conntrackSpark: [] } };
    // Только живые серверы панели: в VM остаются серии удалённых серверов и e2e-тестов.
    const sel = `{server_id=~"${rows.map((r) => r.id).join('|')}"}`;
    const end = Math.floor(Date.now() / 1000);
    const sparkRange = [end - SPARK_SECONDS, end, SPARK_STEP] as const;
    const [cpu, mem, disk, rx, tx, uptime, spark, fleetCpu, fleetTraffic, fleetConntrack] = await Promise.all(
      [
        this.vm.query(`${VM_METRIC_NAMES.cpuPct}${sel}`),
        this.vm.query(`100 * ${VM_METRIC_NAMES.memUsedMb}${sel} / (${VM_METRIC_NAMES.memTotalMb}${sel} > 0)`),
        this.vm.query(
          `100 * ${VM_METRIC_NAMES.diskUsedMb}${sel} / (${VM_METRIC_NAMES.diskTotalMb}${sel} > 0)`,
        ),
        this.vm.query(`${VM_METRIC_NAMES.netRxBps}${sel}`),
        this.vm.query(`${VM_METRIC_NAMES.netTxBps}${sel}`),
        this.vm.query(`nodeservice_uptime_sec${sel}`),
        this.vm.queryRange(`${VM_METRIC_NAMES.cpuPct}${sel}`, end - SPARK_SECONDS, end, SPARK_STEP),
        this.vm.queryRange(`avg(${VM_METRIC_NAMES.cpuPct}${sel})`, ...sparkRange),
        this.vm.queryRange(
          `sum(${VM_METRIC_NAMES.netRxBps}${sel}) + sum(${VM_METRIC_NAMES.netTxBps}${sel})`,
          ...sparkRange,
        ),
        this.vm.queryRange(`sum(${VM_METRIC_NAMES.conntrackCount}${sel})`, ...sparkRange),
      ],
    );
    const vmOk = [cpu, mem, disk, rx, tx, uptime, spark].every((r) => r !== null);
    const fleetSpark = (res: VmMatrixSeries[] | null): Array<number | null> =>
      res?.[0]?.points.map(([, v]) => (Number.isFinite(v) ? v : null)) ?? [];
    const servers: OverviewServerMetrics[] = rows.map((row) => ({
      serverId: row.id,
      cpuPct: lastFor(cpu, row.id),
      memPct: lastFor(mem, row.id),
      diskPct: lastFor(disk, row.id),
      netRxBps: lastFor(rx, row.id),
      netTxBps: lastFor(tx, row.id),
      uptimeSec: lastFor(uptime, row.id),
      cpuSpark: sparkFor(spark, row.id),
    }));
    return {
      vmOk,
      servers,
      fleet: {
        cpuAvgSpark: fleetSpark(fleetCpu),
        trafficSpark: fleetSpark(fleetTraffic),
        conntrackSpark: fleetSpark(fleetConntrack),
      },
    };
  }
}

function toPoints(series: VmMatrixSeries | undefined): MetricPoint[] {
  if (!series) return [];
  return series.points.map(([t, v]) => ({ t, v: Number.isFinite(v) ? v : null }));
}

function lastFor(res: VmMatrixSeries[] | null, serverId: string): number | null {
  const s = res?.find((r) => r.labels.server_id === serverId);
  const v = s?.points.at(-1)?.[1];
  return v !== undefined && Number.isFinite(v) ? v : null;
}

function sparkFor(res: VmMatrixSeries[] | null, serverId: string): Array<number | null> {
  const s = res?.find((r) => r.labels.server_id === serverId);
  if (!s) return [];
  return s.points.map(([, v]) => (Number.isFinite(v) ? v : null));
}
