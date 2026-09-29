import { Inject, Injectable } from '@nestjs/common';
import {
  FLEET_STATS_PERIOD_SPEC,
  type FleetStats,
  type FleetStatsPeriod,
  INCIDENT_KIND_META,
  type IncidentKind,
  VM_METRIC_NAMES,
} from '@nodeservice/shared';
import { and, eq, gte, isNull, lt, or } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { billingPayments, incidents, servers } from '../../infra/db/schema/index.js';
import type { VmMatrixSeries } from '../metrics/vm-reader.service.js';
import { VmReaderService } from '../metrics/vm-reader.service.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { avgOf, coveredSeconds, peakOf, round1 } from './fleet-stats.logic.js';

/** Виды инцидентов, при которых сервер считается «не на связи». */
const DOWN_KINDS = new Set(['agent_offline', 'ssh_down']);
/** Метрика онлайна нод, которую пишет панель при каждом чтении Remnawave. */
export const NODE_ONLINE_METRIC = 'nodeservice_node_online';

const iso = (sec: number) => new Date(sec * 1000).toISOString();
const byServer = (res: VmMatrixSeries[] | null): Map<string, number> => {
  const m = new Map<string, number>();
  for (const s of res ?? []) {
    const id = s.labels.server_id;
    const v = s.points.at(-1)?.[1];
    if (id && v !== undefined && Number.isFinite(v)) m.set(id, v);
  }
  return m;
};
const total = (m: Map<string, number>): number | null =>
  m.size === 0 ? null : [...m.values()].reduce((a, b) => a + b, 0);

/**
 * Статистика всего парка за период. Всё только читается: VictoriaMetrics (трафик, нагрузка, онлайн нод),
 * база (инциденты, оплаты). Недоступная VM — не ошибка: vmOk=false, остальное считается как обычно.
 */
@Injectable()
export class FleetStatsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vm: VmReaderService,
    private readonly remnawave: RemnawaveService,
  ) {}

  async stats(period: FleetStatsPeriod): Promise<FleetStats> {
    const spec = FLEET_STATS_PERIOD_SPEC[period];
    const P = spec.seconds;
    const nowMs = Date.now();
    const end = Math.floor(nowMs / 1000);
    const start = end - P;
    const rows = await this.db.select({ id: servers.id, name: servers.name }).from(servers);
    const name = new Map(rows.map((r) => [r.id, r.name]));
    const sel = rows.length > 0 ? `{server_id=~"${rows.map((r) => r.id).join('|')}"}` : '{server_id="none"}';
    const M = VM_METRIC_NAMES;
    const memPct = `(100 * ${M.memUsedMb}${sel} / (${M.memTotalMb}${sel} > 0))`;
    const diskPct = `(100 * ${M.diskUsedMb}${sel} / (${M.diskTotalMb}${sel} > 0))`;
    const [
      rx,
      tx,
      prevRx,
      prevTx,
      buckets,
      speedRx,
      speedTx,
      cpuAvg,
      cpuMax,
      memAvg,
      memMax,
      conn,
      diskNow,
      diskThen,
      online,
    ] = await Promise.all([
      this.vm.query(`integrate(${M.netRxBps}${sel}[${P}s])`),
      this.vm.query(`integrate(${M.netTxBps}${sel}[${P}s])`),
      this.vm.query(`sum(integrate(${M.netRxBps}${sel}[${P}s] offset ${P}s))`),
      this.vm.query(`sum(integrate(${M.netTxBps}${sel}[${P}s] offset ${P}s))`),
      this.vm.queryRange(
        `sum(integrate(${M.netRxBps}${sel}[${spec.bucket}s])) + sum(integrate(${M.netTxBps}${sel}[${spec.bucket}s]))`,
        start + spec.bucket,
        end,
        spec.bucket,
      ),
      this.vm.queryRange(`sum(avg_over_time(${M.netRxBps}${sel}[${spec.step}s]))`, start, end, spec.step),
      this.vm.queryRange(`sum(avg_over_time(${M.netTxBps}${sel}[${spec.step}s]))`, start, end, spec.step),
      this.vm.query(`avg_over_time(${M.cpuPct}${sel}[${P}s])`),
      this.vm.query(`max_over_time(${M.cpuPct}${sel}[${P}s])`),
      this.vm.query(`avg_over_time(${memPct}[${P}s:${spec.step}s])`),
      this.vm.query(`max_over_time(${memPct}[${P}s:${spec.step}s])`),
      this.vm.queryRange(`sum(${M.conntrackCount}${sel})`, start, end, spec.step),
      this.vm.query(diskPct),
      this.vm.query(`${diskPct.replaceAll(`${sel}`, `${sel} offset ${P}s`)}`),
      this.vm.queryRange(`sum(max_over_time(${NODE_ONLINE_METRIC}[${spec.step}s]))`, start, end, spec.step),
    ]);
    const vmOk = [rx, tx, cpuAvg].every((r) => r !== null);

    // Трафик: integrate даёт биты, делим на 8.
    const rxBy = byServer(rx);
    const txBy = byServer(tx);
    const rxTotal = total(rxBy);
    const txTotal = total(txBy);
    const scalar = (r: VmMatrixSeries[] | null) => r?.[0]?.points.at(-1)?.[1] ?? null;
    const prevBits =
      scalar(prevRx) !== null || scalar(prevTx) !== null
        ? (scalar(prevRx) ?? 0) + (scalar(prevTx) ?? 0)
        : null;
    const rxPts = speedRx?.[0]?.points ?? [];
    const txPts = speedTx?.[0]?.points ?? [];
    const txAt = new Map(txPts);
    const speed = rxPts.map(([t, v]) => ({ at: iso(t), rx: v, tx: txAt.get(t) ?? 0 }));
    const sumPts = rxPts.map(([t, v]) => [t, v + (txAt.get(t) ?? 0)] as [number, number]);
    const peak = peakOf(sumPts);

    // Нагрузка.
    const cpuA = byServer(cpuAvg);
    const cpuM = byServer(cpuMax);
    const memA = byServer(memAvg);
    const memM = byServer(memMax);
    const dNow = byServer(diskNow);
    const dThen = byServer(diskThen);
    const maxEntry = (m: Map<string, number>) =>
      [...m.entries()].reduce<[string, number] | null>((b, e) => (!b || e[1] > b[1] ? e : b), null);
    const cpuPeak = maxEntry(cpuM);
    const memPeak = maxEntry(memM);
    const diskPeak = maxEntry(dNow);
    const growth = [...dNow.entries()]
      .filter(([id]) => dThen.has(id))
      .map(([id, v]) => v - (dThen.get(id) ?? v));
    const connVals = (conn?.[0]?.points ?? []).map(([, v]) => v);

    // Доступность и инциденты — из базы.
    // В базе — точное время: иначе инцидент, открытый в эту же секунду, выпал бы из подсчёта.
    const toD = new Date(nowMs);
    const fromD = new Date(nowMs - P * 1000);
    const incRows = await this.db
      .select()
      .from(incidents)
      .where(
        or(gte(incidents.openedAt, fromD), isNull(incidents.resolvedAt), gte(incidents.resolvedAt, fromD)),
      );
    const downBy = new Map<string, Array<[number, number]>>();
    for (const i of incRows) {
      if (!i.serverId || !DOWN_KINDS.has(i.kind)) continue;
      const a = i.openedAt.getTime();
      const b = (i.resolvedAt ?? toD).getTime();
      if (b < fromD.getTime()) continue;
      downBy.set(i.serverId, [...(downBy.get(i.serverId) ?? []), [a, b]]);
    }
    const uptime = new Map<string, number>();
    for (const r of rows)
      uptime.set(
        r.id,
        100 * (1 - coveredSeconds(downBy.get(r.id) ?? [], fromD.getTime(), toD.getTime()) / P),
      );
    const opened = incRows.filter((i) => i.openedAt >= fromD && i.openedAt < toD);
    const fixMin = (list: typeof opened) =>
      avgOf(
        list
          .filter((i) => i.resolvedAt)
          .map((i) => ((i.resolvedAt as Date).getTime() - i.openedAt.getTime()) / 60_000),
      );
    const kinds = new Map<string, typeof opened>();
    for (const i of opened) kinds.set(i.kind, [...(kinds.get(i.kind) ?? []), i]);

    // Стоимость — из «Биллинга» за тот же промежуток.
    const paid = await this.db
      .select({ rub: billingPayments.amountRubMinor })
      .from(billingPayments)
      .where(
        and(
          eq(billingPayments.counted, true),
          gte(billingPayments.paidAt, fromD),
          lt(billingPayments.paidAt, toD),
        ),
      );
    const spent = paid.reduce((a, p) => a + p.rub, 0);
    const rw = await this.remnawave.status().catch(() => null);
    const users = rw?.stats?.users.total ?? null;
    const totalBytes = rxTotal !== null || txTotal !== null ? ((rxTotal ?? 0) + (txTotal ?? 0)) / 8 : null;

    const onlinePts = online?.[0]?.points ?? [];
    const onlinePeak = peakOf(onlinePts);

    return {
      period,
      from: fromD.toISOString(),
      to: toD.toISOString(),
      vmOk,
      traffic: {
        rxBytes: rxTotal === null ? null : rxTotal / 8,
        txBytes: txTotal === null ? null : txTotal / 8,
        prevTotalBytes: prevBits === null ? null : prevBits / 8,
        peakBps: peak?.value ?? null,
        peakAt: peak ? iso(peak.at) : null,
        avgBps: avgOf(sumPts.map(([, v]) => v)),
        buckets: (buckets?.[0]?.points ?? []).map(([t, v]) => ({ at: iso(t - spec.bucket), bytes: v / 8 })),
        speed,
      },
      availability: {
        pct: rows.length === 0 ? null : round1(avgOf([...uptime.values()]) as number),
        incidents: opened.length,
        avgFixMin: round1(fixMin(opened)),
      },
      cost: {
        spentRubMinor: spent,
        perTbRubMinor: totalBytes && totalBytes > 1e9 ? Math.round(spent / (totalBytes / 1e12)) : null,
        perUserRubMinor: users ? Math.round(spent / users) : null,
        users,
      },
      load: {
        cpu: {
          avg: round1(avgOf([...cpuA.values()])),
          peak: round1(cpuPeak?.[1] ?? null),
          peakServer: cpuPeak ? (name.get(cpuPeak[0]) ?? null) : null,
        },
        mem: {
          avg: round1(avgOf([...memA.values()])),
          peak: round1(memPeak?.[1] ?? null),
          peakServer: memPeak ? (name.get(memPeak[0]) ?? null) : null,
        },
        conntrack: {
          avg: connVals.length ? Math.round(avgOf(connVals) as number) : null,
          peak: connVals.length ? Math.max(...connVals) : null,
        },
        disk: {
          avg: round1(avgOf([...dNow.values()])),
          peak: round1(diskPeak?.[1] ?? null),
          peakServer: diskPeak ? (name.get(diskPeak[0]) ?? null) : null,
          growthPct: growth.length ? round1(Math.max(...growth)) : null,
        },
      },
      incidentsByKind: [...kinds.entries()]
        .map(([kind, list]) => ({
          kind,
          label: INCIDENT_KIND_META[kind as IncidentKind]?.label ?? kind,
          count: list.length,
          avgMin: round1(fixMin(list)),
        }))
        .sort((a, b) => b.count - a.count),
      online: {
        points: onlinePts.map(([t, v]) => ({ at: iso(t), value: v })),
        peak: onlinePeak?.value ?? null,
        peakAt: onlinePeak ? iso(onlinePeak.at) : null,
        avg: onlinePts.length ? Math.round(avgOf(onlinePts.map(([, v]) => v)) as number) : null,
      },
      servers: rows
        .map((r) => {
          const bits =
            rxBy.has(r.id) || txBy.has(r.id) ? (rxBy.get(r.id) ?? 0) + (txBy.get(r.id) ?? 0) : null;
          const bytes = bits === null ? null : bits / 8;
          return {
            id: r.id,
            name: r.name,
            trafficBytes: bytes,
            sharePct: bytes !== null && totalBytes ? round1((100 * bytes) / totalBytes) : null,
            cpuAvg: round1(cpuA.get(r.id) ?? null),
            cpuPeak: round1(cpuM.get(r.id) ?? null),
            memAvg: round1(memA.get(r.id) ?? null),
            uptimePct: round1(uptime.get(r.id) ?? null),
          };
        })
        .sort((a, b) => (b.trafficBytes ?? -1) - (a.trafficBytes ?? -1)),
    };
  }
}
