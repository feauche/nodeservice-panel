import { FLEET_STATS_PERIOD_SPEC, type FleetStats, type FleetStatsPeriod } from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockServers } from './servers-mock';

/** Мок статистики парка: правдоподобные цифры, считаются от длины периода. */
export const mockFleetStats = { vmOk: true, onlineRecorded: true };

function wave(n: number, base: number, amp: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < n; i += 1) {
    x = (x * 9301 + 49_297) % 233_280;
    out.push(Math.max(0, base + amp * Math.sin(i / 2.3) + amp * 0.6 * (x / 233_280 - 0.5)));
  }
  return out;
}

export function fleetStats(period: FleetStatsPeriod): FleetStats {
  const spec = FLEET_STATS_PERIOD_SPEC[period];
  const end = Date.now();
  const start = end - spec.seconds * 1000;
  const days = spec.seconds / 86_400;
  const bucketN = Math.round(spec.seconds / spec.bucket);
  const stepN = Math.min(120, Math.round(spec.seconds / spec.step));
  const perBucket = (8.2e12 * spec.bucket) / 86_400;
  const buckets = wave(bucketN, perBucket, perBucket * 0.25, 7).map((bytes, i) => ({
    at: new Date(start + i * spec.bucket * 1000).toISOString(),
    bytes,
  }));
  const rxs = wave(stepN, 480e6, 150e6, 3);
  const txs = wave(stepN, 455e6, 140e6, 11);
  const speed = rxs.map((rx, i) => ({
    at: new Date(start + (i * spec.seconds * 1000) / stepN).toISOString(),
    rx,
    tx: txs[i] ?? 0,
  }));
  const total = buckets.reduce((a, b) => a + b.bytes, 0);
  const shares = [0.34, 0.28, 0.2, 0.12, 0.06];
  const vm = mockFleetStats.vmOk;
  return {
    period,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    vmOk: vm,
    traffic: {
      rxBytes: vm ? total * 0.52 : null,
      txBytes: vm ? total * 0.48 : null,
      prevTotalBytes: vm ? total * 0.89 : null,
      peakBps: vm ? 1.84e9 : null,
      peakAt: vm ? new Date(end - 6 * 3_600_000).toISOString() : null,
      avgBps: vm ? 492e6 : null,
      buckets: vm ? buckets : [],
      speed: vm ? speed : [],
    },
    availability: { pct: 99.79, incidents: Math.max(1, Math.round(days / 3.3)), avgFixMin: 14 },
    cost: {
      spentRubMinor: Math.round(4_010_000 * (days / 30)),
      perTbRubMinor: 16_300,
      perUserRubMinor: 750,
      users: 5366,
    },
    load: {
      cpu: { avg: 14, peak: 88, peakServer: mockServers.items[0]?.name ?? null },
      mem: { avg: 41, peak: 79, peakServer: mockServers.items[1]?.name ?? null },
      conntrack: { avg: 142_000, peak: 231_000 },
      disk: { avg: 38, peak: 71, peakServer: mockServers.items[0]?.name ?? null, growthPct: 9 },
    },
    incidentsByKind: [
      { kind: 'node_blocked', label: 'Резкое падение онлайна', count: 4, avgMin: 9 },
      { kind: 'agent_offline', label: 'Агент не в сети', count: 3, avgMin: 22 },
    ],
    online: mockFleetStats.onlineRecorded
      ? {
          points: wave(stepN, 5100, 900, 5).map((value, i) => ({
            at: new Date(start + (i * spec.seconds * 1000) / stepN).toISOString(),
            value: Math.round(value),
          })),
          peak: 6230,
          peakAt: new Date(end - 3 * 3_600_000).toISOString(),
          avg: 5104,
        }
      : { points: [], peak: null, peakAt: null, avg: null },
    servers: mockServers.items.map((s, i) => ({
      id: s.id,
      name: s.name,
      trafficBytes: vm ? total * (shares[i] ?? 0.02) : null,
      sharePct: vm ? (shares[i] ?? 0.02) * 100 : null,
      cpuAvg: 12 + i * 5,
      cpuPeak: 60 + i * 10,
      memAvg: 40 + i * 4,
      uptimePct: i === 1 ? 98.9 : 100,
    })),
  };
}

export const fleetStatsHandlers = [
  http.get('/api/fleet/stats', ({ request }) => {
    const p = (new URL(request.url).searchParams.get('period') ?? 'month') as FleetStatsPeriod;
    return HttpResponse.json(fleetStats(p));
  }),
];

export function resetFleetStats(): void {
  mockFleetStats.vmOk = true;
  mockFleetStats.onlineRecorded = true;
}
