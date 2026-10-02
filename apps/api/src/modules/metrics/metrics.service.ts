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
import { NODE_ONLINE_METRIC } from '../fleet-stats/fleet-stats.service.js';
import { NodeLinkService } from '../remnawave/node-link.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
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
    private readonly remnawave: RemnawaveService,
    private readonly links: NodeLinkService,
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
    const [server, remna] = await Promise.all([
      this.servers.findById(serverId).catch(() => null),
      this.remnawave.status().catch(() => null),
    ]);
    let online: ServerMetricsResponse['online'] = null;
    if (server && remna?.nodes.length) {
      const node = (
        await this.links.resolve(
          [
            {
              id: server.id,
              name: server.name,
              host: server.host,
              nodeLink: server.nodeLink,
              facts: {
                hostname: server.hostname,
                os: server.os,
                osVersion: server.osVersion,
                arch: server.arch,
                kernel: server.kernel,
                cpuCores: server.cpuCores,
                memoryMb: server.memoryMb,
                addresses: server.addresses,
              },
            },
          ],
          remna.nodes,
        )
      ).nodeOf(serverId);
      if (node) {
        const result = await this.vm.queryRange(
          `max(${NODE_ONLINE_METRIC}{node_uuid="${node.uuid}"})`,
          start,
          end,
          stepSeconds,
        );
        if (result === null) vmOk = false;
        online = { nodeUuid: node.uuid, name: node.name, points: toPoints(result?.[0]) };
      }
    }
    return { range, stepSeconds, vmOk, series, online };
  }

  async overview(): Promise<OverviewMetricsResponse> {
    const rows = await this.servers.list();
    if (rows.length === 0)
      return {
        vmOk: true,
        servers: [],
        fleet: { cpuAvgSpark: [], trafficRxSpark: [], trafficTxSpark: [], conntrackSpark: [] },
      };
    // Только живые серверы панели: в VM остаются серии удалённых серверов и e2e-тестов.
    const sel = `{server_id=~"${rows.map((r) => r.id).join('|')}"}`;
    const end = Math.floor(Date.now() / 1000);
    const sparkRange = [end - SPARK_SECONDS, end, SPARK_STEP] as const;
    const [cpu, mem, disk, rx, tx, uptime, spark, fleetCpu, fleetRx, fleetTx, fleetConntrack] =
      await Promise.all([
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
        this.vm.queryRange(`sum(${VM_METRIC_NAMES.netRxBps}${sel})`, ...sparkRange),
        this.vm.queryRange(`sum(${VM_METRIC_NAMES.netTxBps}${sel})`, ...sparkRange),
        this.vm.queryRange(`sum(${VM_METRIC_NAMES.conntrackCount}${sel})`, ...sparkRange),
      ]);
    const vmOk = [cpu, mem, disk, rx, tx, uptime, spark].every((r) => r !== null);
    const fleetSpark = (res: VmMatrixSeries[] | null): Array<number | null> =>
      res?.[0]?.points.map(([, v]) => (Number.isFinite(v) ? v : null)) ?? [];
    // Агент не на связи — последние значения устарели (могут быть многочасовой давности): не показываем их
    // вовсе, иначе карточка рисует «CPU 12 %» у сервера, который молчит (решение владельца 29.09.2026).
    const servers: OverviewServerMetrics[] = rows.map((row) =>
      row.agentStatus !== 'online'
        ? {
            serverId: row.id,
            cpuPct: null,
            memPct: null,
            diskPct: null,
            netRxBps: null,
            netTxBps: null,
            uptimeSec: null,
            cpuSpark: [],
          }
        : {
            serverId: row.id,
            cpuPct: lastFor(cpu, row.id),
            memPct: lastFor(mem, row.id),
            diskPct: lastFor(disk, row.id),
            netRxBps: lastFor(rx, row.id),
            netTxBps: lastFor(tx, row.id),
            uptimeSec: lastFor(uptime, row.id),
            cpuSpark: sparkFor(spark, row.id),
          },
    );
    return {
      vmOk,
      servers,
      fleet: {
        cpuAvgSpark: fleetSpark(fleetCpu),
        trafficRxSpark: fleetSpark(fleetRx),
        trafficTxSpark: fleetSpark(fleetTx),
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
