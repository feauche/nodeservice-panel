import {
  METRIC_RANGES,
  type MetricPoint,
  type MetricRange,
  type OverviewServerMetrics,
  SERVER_METRIC_KEYS,
  type ServerMetricKey,
} from '@nodeservice/shared';
import { HttpResponse, http } from 'msw';

import { mockServers } from './servers-mock';

/** Мок метрик: детерминированная синтетика (по id сервера), управляемая флагами. */
export const mockMetrics = {
  vmOk: true,
  /** false — метрик нет ни у кого (агент ещё не подключался): пустые серии и null-значения. */
  hasData: true,
};

// Режим VITE_MOCK=1: управление из скриншот-сценариев (метрик нет → пустые состояния).
if (typeof window !== 'undefined')
  (window as unknown as { __nsMockMetrics: typeof mockMetrics }).__nsMockMetrics = mockMetrics;

export function seedMetrics(): void {
  mockMetrics.vmOk = true;
  mockMetrics.hasData = true;
}

const hash = (s: string): number => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);

const BASE: Record<ServerMetricKey, [number, number]> = {
  cpuPct: [35, 25],
  load1: [0.8, 0.6],
  memUsedMb: [3200, 900],
  memTotalMb: [8192, 0],
  diskUsedMb: [22000, 4000],
  diskTotalMb: [51200, 0],
  netRxBps: [18_000_000, 12_000_000],
  netTxBps: [11_000_000, 8_000_000],
  netRxPps: [4200, 1800],
  netTxPps: [3100, 1400],
  conntrackCount: [5400, 2100],
};

function value(key: ServerMetricKey, seed: number, t: number): number {
  const [base, amp] = BASE[key];
  const wave = Math.sin(t / 240 + seed) * 0.5 + Math.sin(t / 37 + seed * 2) * 0.3;
  return Math.max(0, Math.round((base + amp * wave) * 100) / 100);
}

export function genSeries(serverId: string, key: ServerMetricKey, range: MetricRange): MetricPoint[] {
  if (!mockMetrics.hasData) return [];
  const { seconds, stepSeconds } = METRIC_RANGES[range];
  const end = Math.floor(Date.now() / 1000);
  const seed = hash(serverId);
  const points: MetricPoint[] = [];
  for (let t = end - seconds; t <= end; t += stepSeconds) points.push({ t, v: value(key, seed, t) });
  return points;
}

export const metricsHandlers = [
  http.get('/api/metrics/overview', () => {
    const servers: OverviewServerMetrics[] = mockServers.items.map((s) => {
      const seed = hash(s.id);
      const now = Math.floor(Date.now() / 1000);
      const has = mockMetrics.hasData;
      return {
        serverId: s.id,
        cpuPct: has ? value('cpuPct', seed, now) : null,
        memPct: has ? Math.round((value('memUsedMb', seed, now) / 8192) * 1000) / 10 : null,
        diskPct: has ? Math.round((value('diskUsedMb', seed, now) / 51200) * 1000) / 10 : null,
        netRxBps: has ? value('netRxBps', seed, now) : null,
        netTxBps: has ? value('netTxBps', seed, now) : null,
        uptimeSec: has ? 86_400 * 12 + seed : null,
        cpuSpark: has ? Array.from({ length: 30 }, (_, i) => value('cpuPct', seed, now - (29 - i) * 30)) : [],
      };
    });
    const now = Math.floor(Date.now() / 1000);
    const fleetSpark = (key: ServerMetricKey, scale = 1): Array<number | null> =>
      mockMetrics.hasData
        ? Array.from(
            { length: 30 },
            (_, i) =>
              mockServers.items.reduce((acc, s) => acc + value(key, hash(s.id), now - (29 - i) * 30), 0) *
              scale,
          )
        : [];
    return HttpResponse.json({
      vmOk: mockMetrics.vmOk,
      servers,
      fleet: {
        cpuAvgSpark: fleetSpark('cpuPct', mockServers.items.length ? 1 / mockServers.items.length : 1),
        trafficRxSpark: fleetSpark('netRxBps'),
        trafficTxSpark: fleetSpark('netTxBps'),
        conntrackSpark: fleetSpark('conntrackCount'),
      },
    });
  }),
  http.get('/api/metrics/servers/:id', ({ params, request }) => {
    const range = (new URL(request.url).searchParams.get('range') ?? '1h') as MetricRange;
    const online = mockServers.items.find((sv) => sv.id === params.id)?.agentStatus === 'online';
    const series = Object.fromEntries(
      SERVER_METRIC_KEYS.map((k) => [k, online ? genSeries(String(params.id), k, range) : []]),
    );
    return HttpResponse.json({
      range,
      stepSeconds: METRIC_RANGES[range].stepSeconds,
      vmOk: mockMetrics.vmOk,
      series,
    });
  }),
];
