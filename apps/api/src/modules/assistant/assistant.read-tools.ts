import {
  ATTEMPT_STATUS_LABELS,
  actionMeta,
  INCIDENT_CHAINS,
  type Incident,
  METRIC_RANGES,
  metricRangeSchema,
  NODE_STATE_LABELS,
  NODE_WATCH_LABELS,
  SERVER_METRIC_KEYS,
  type Server,
  VM_METRIC_NAMES,
} from '@nodeservice/shared';

import type { IncidentMetricsService } from '../incidents/incident-metrics.service.js';
import type { IncidentsService } from '../incidents/incidents.service.js';
import type { MaintenanceService } from '../maintenance/maintenance.service.js';
import type { VmReaderService } from '../metrics/vm-reader.service.js';
import type { ProvidersService } from '../providers/providers.service.js';
import type { ServersService } from '../servers/servers.service.js';
import type { ToolOutcome } from './assistant.tools.js';
import type { LlmToolDef } from './llm.provider.js';

/** Инструменты только для чтения (уровень T0): ассистент видит парк, но ничего не меняет. */
export const READ_TOOL_DEFS: LlmToolDef[] = [
  {
    name: 'get_fleet_status',
    description:
      'Сводка по всему парку одним вызовом. Вверху итоги (сколько серверов, агентов в сети, остановленных нод, недоступных по SSH, открытых инцидентов). По каждому серверу: имя, id, адрес, теги, провайдер, агент (статус, версия, когда выходил на связь), SSH, контейнер ноды (следим ли и что видел зонд), ОС, ядра, память, свежие CPU/память/диск в процентах, открытые инциденты. С него начинай любой вопрос «как дела в парке».',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_server_detail',
    description:
      'Всё об одном сервере: поля, агент, SSH, нода, провайдер, свежие метрики (CPU, память, диск, сеть, conntrack, аптайм), открытые и недавние инциденты, сводка обслуживания (обновления, перезагрузка, диск). serverId — id ИЛИ имя сервера.',
    input_schema: {
      type: 'object',
      properties: { serverId: { type: 'string', description: 'id или имя сервера' } },
      required: ['serverId'],
    },
  },
  {
    name: 'get_metrics_history',
    description:
      'История одной метрики сервера за период со сводкой: последнее, минимум, среднее, максимум, когда был пик, тренд (растёт/падает/ровно) и до 12 точек для формы графика. metric: cpuPct|load1|memUsedMb|memTotalMb|memPct|diskUsedMb|diskTotalMb|diskPct|netRxBps|netTxBps|netRxPps|netTxPps|conntrackCount. range: 1h (по умолчанию)|24h|7d. Зови, когда спрашивают «что было», «когда началось», «растёт ли».',
    input_schema: {
      type: 'object',
      properties: {
        serverId: { type: 'string', description: 'id или имя сервера' },
        metric: { type: 'string' },
        range: { type: 'string', description: '1h | 24h | 7d' },
      },
      required: ['serverId', 'metric'],
    },
  },
  {
    name: 'list_incidents',
    description:
      'Список инцидентов, новые сверху. status: open (открытые) | resolved (закрытые) | all (по умолчанию). serverId (id или имя) — только по одному серверу. limit — сколько вернуть (до 25, по умолчанию 10). По каждому: id, сервер, вид, важность, статус, заголовок, времена, чем закончилось, есть ли предложение.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        serverId: { type: 'string', description: 'id или имя сервера' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_incident',
    description:
      'Полное дело инцидента по id: что случилось, снимок сигналов в момент сбоя (CPU, память, диск, нода, агент), хронология, попытки починки (действие, уровень, кто запускал, чем кончилось, хвост вывода), текущее предложение и цепочка шагов с пометкой, что уже пробовали. Зови перед любым разбором или предложением действия.',
    input_schema: {
      type: 'object',
      properties: { incidentId: { type: 'string' } },
      required: ['incidentId'],
    },
  },
  {
    name: 'get_maintenance',
    description:
      'Обслуживание сервера: сколько обновлений (из них безопасности), нужна ли перезагрузка, ядро, автообновления, версия агента (установлена и последняя), свободное место, предупреждения последней проверки, идёт ли сейчас запуск и чем кончился прошлый. serverId — id или имя.',
    input_schema: {
      type: 'object',
      properties: { serverId: { type: 'string', description: 'id или имя сервера' } },
      required: ['serverId'],
    },
  },
];

export interface ReadDeps {
  servers: ServersService;
  incidents: IncidentsService;
  metrics: VmReaderService;
  incidentMetrics: Pick<IncidentMetricsService, 'latest'>;
  providers: Pick<ProvidersService, 'list'>;
  maintenance: Pick<MaintenanceService, 'state'>;
}

const HISTORY_METRICS = new Set<string>([...SERVER_METRIC_KEYS, 'memPct', 'diskPct']);
const UNITS: Record<string, string> = {
  cpuPct: '%',
  memPct: '%',
  diskPct: '%',
  load1: '',
  memUsedMb: 'МБ',
  memTotalMb: 'МБ',
  diskUsedMb: 'МБ',
  diskTotalMb: 'МБ',
  netRxBps: 'байт/с',
  netTxBps: 'байт/с',
  netRxPps: 'пакетов/с',
  netTxPps: 'пакетов/с',
  conntrackCount: 'соединений',
};
const LOG_TAIL = 700;
const HISTORY_POINTS = 12;

const r2 = (n: number): number => Math.round(n * 100) / 100;
const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Сервер по id, точному имени или однозначной части имени (без учёта регистра). */
export function findServer(servers: Server[], key: string): Server | undefined {
  const k = key.trim().toLowerCase();
  if (!k) return undefined;
  const byId = servers.find((s) => s.id.toLowerCase() === k);
  if (byId) return byId;
  const exact = servers.filter((s) => s.name.toLowerCase() === k);
  if (exact.length === 1) return exact[0];
  const part = servers.filter((s) => s.name.toLowerCase().includes(k));
  return part.length === 1 ? part[0] : undefined;
}

const notFound = (servers: Server[]): ToolOutcome => ({
  content: `Сервер не найден или имя неоднозначно. Доступные серверы: ${
    servers.map((s) => s.name).join(', ') || 'нет ни одного'
  }.`,
  citations: [],
  proposals: [],
});

export interface SeriesSummary {
  samples: number;
  last: number;
  min: number;
  avg: number;
  max: number;
  peakAt: string;
  trend: 'растёт' | 'падает' | 'ровно';
  points: Array<{ at: string; v: number }>;
}

/** Сводка ряда: ассистенту нужна форма (пик, тренд), а не сотни точек. */
export function summarizeSeries(raw: Array<[number, number]>): SeriesSummary | null {
  const pts = raw.filter(([, v]) => Number.isFinite(v));
  if (pts.length === 0) return null;
  const vals = pts.map((p) => p[1]);
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  const mean = avg(vals);
  const third = Math.max(1, Math.floor(vals.length / 3));
  const delta = avg(vals.slice(-third)) - avg(vals.slice(0, third));
  const threshold = 0.15 * Math.max(Math.abs(mean), max - min);
  const peak = pts[vals.indexOf(max)] as [number, number];
  const step = Math.max(1, (pts.length - 1) / (HISTORY_POINTS - 1));
  const picked = new Set<number>();
  for (let i = 0; i < HISTORY_POINTS && Math.round(i * step) < pts.length; i += 1)
    picked.add(Math.round(i * step));
  picked.add(pts.length - 1);
  return {
    samples: pts.length,
    last: r2(vals.at(-1) as number),
    min: r2(min),
    avg: r2(mean),
    max: r2(max),
    peakAt: new Date(peak[0] * 1000).toISOString(),
    trend: Math.abs(delta) <= threshold ? 'ровно' : delta > 0 ? 'растёт' : 'падает',
    points: [...picked]
      .sort((a, b) => a - b)
      .map((i) => ({
        at: new Date((pts[i] as [number, number])[0] * 1000).toISOString(),
        v: r2(vals[i] as number),
      })),
  };
}

function historyQuery(metric: string, serverId: string): string {
  const sel = `{server_id="${serverId}"}`;
  if (metric === 'memPct')
    return `100 * ${VM_METRIC_NAMES.memUsedMb}${sel} / (${VM_METRIC_NAMES.memTotalMb}${sel} > 0)`;
  if (metric === 'diskPct')
    return `100 * ${VM_METRIC_NAMES.diskUsedMb}${sel} / (${VM_METRIC_NAMES.diskTotalMb}${sel} > 0)`;
  return `${VM_METRIC_NAMES[metric as keyof typeof VM_METRIC_NAMES]}${sel}`;
}

async function lastValue(vm: VmReaderService, promql: string): Promise<number | null> {
  const res = await vm.query(promql);
  const v = res?.[0]?.points.at(-1)?.[1];
  return v !== undefined && Number.isFinite(v) ? r2(v) : null;
}

/** Коротко об инциденте: для списка и для сводки по серверу. */
export function briefIncident(i: Incident) {
  const fixes = i.attempts.filter((a) => a.level !== 'T0');
  const last = fixes.at(-1);
  return {
    id: i.id,
    server: i.serverName,
    serverId: i.serverId,
    kind: i.kind,
    severity: i.severity,
    status: i.status,
    title: i.title,
    openedAt: i.openedAt,
    resolvedAt: i.resolvedAt,
    resolvedBy: i.resolvedBy,
    attempts: i.attempts.length,
    lastFix: last
      ? { action: actionMeta(last.action).title, result: ATTEMPT_STATUS_LABELS[last.status], by: last.by }
      : null,
    proposal: i.proposal ? actionMeta(i.proposal.action).title : null,
  };
}

/** Дело целиком: всё, что нужно для разбора причин и выбора следующего шага. */
export function incidentCase(i: Incident) {
  const tried = new Set(i.attempts.map((a) => a.action));
  return {
    ...briefIncident(i),
    detail: i.detail,
    snapshot: i.snapshot,
    timeline: i.timeline.map((e) => ({
      at: e.at,
      by: e.by,
      action: actionMeta(e.action).title,
      result: e.result,
      level: e.level ?? null,
    })),
    attempts: i.attempts.map((a) => ({
      action: actionMeta(a.action).title,
      level: a.level,
      by: a.by,
      status: ATTEMPT_STATUS_LABELS[a.status],
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      steps: a.steps.map((s) => `${s.key}: ${s.status}`),
      logTail: a.log.length > LOG_TAIL ? `…${a.log.slice(-LOG_TAIL)}` : a.log,
    })),
    proposalDetail: i.proposal
      ? {
          action: actionMeta(i.proposal.action).title,
          level: i.proposal.level,
          reason: i.proposal.reason,
        }
      : null,
    chain: INCIDENT_CHAINS[i.kind].map((key) => {
      const m = actionMeta(key);
      return { key, title: m.title, level: m.level, tried: tried.has(key) };
    }),
  };
}

const none = (content: string): ToolOutcome => ({ content, citations: [], proposals: [] });

/** Выполнить инструмент чтения; null — это не он, пусть разбирается основной исполнитель. */
export async function runReadTool(
  name: string,
  arg: Record<string, unknown>,
  deps: ReadDeps,
): Promise<ToolOutcome | null> {
  if (name === 'get_fleet_status') {
    const [servers, open, providers] = await Promise.all([
      deps.servers.list(),
      deps.incidents.list('open'),
      deps.providers.list(),
    ]);
    const latest = await deps.incidentMetrics.latest(servers.map((s) => s.id));
    const provider = new Map(providers.map((p) => [p.id, p.name]));
    const rows = servers.map((s) => {
      const inc = open.items.filter((i) => i.serverId === s.id);
      const pct = (m: Map<string, number>) => (m.has(s.id) ? r2(m.get(s.id) as number) : null);
      return {
        id: s.id,
        name: s.name,
        address: `${s.sshUser}@${s.host}:${s.port}`,
        tags: s.tags,
        provider: s.providerId ? (provider.get(s.providerId) ?? null) : null,
        agent: s.agentStatus,
        agentVersion: s.agentVersion,
        agentLastSeenAt: s.agentLastSeenAt,
        ssh: s.sshOk,
        nodeWatch: NODE_WATCH_LABELS[s.nodeWatch],
        node: s.node ? NODE_STATE_LABELS[s.node] : null,
        os: [s.facts.os, s.facts.osVersion].filter(Boolean).join(' ') || null,
        arch: s.facts.arch,
        cpuCores: s.facts.cpuCores,
        memoryMb: s.facts.memoryMb,
        cpuPct: pct(latest.cpu),
        memPct: pct(latest.mem),
        diskPct: pct(latest.disk),
        lastCheck: s.lastSshCheckAt,
        openIncidents: inc.map((i) => ({ id: i.id, title: i.title, severity: i.severity })),
      };
    });
    return {
      content: JSON.stringify({
        totals: {
          servers: servers.length,
          agentOnline: servers.filter((s) => s.agentStatus === 'online').length,
          agentOffline: servers.filter((s) => s.agentStatus === 'offline').length,
          sshDown: servers.filter((s) => s.sshOk === false).length,
          nodeStopped: servers.filter((s) => s.node === 'stopped').length,
          openIncidents: open.items.length,
        },
        servers: rows,
      }),
      citations: open.items.slice(0, 3).map((i) => ({ type: 'incident', id: i.id, label: i.title })),
      proposals: [],
    };
  }

  if (name === 'get_server_detail') {
    const servers = await deps.servers.list();
    const s = findServer(servers, String(arg.serverId ?? ''));
    if (!s) return notFound(servers);
    const sel = `{server_id="${s.id}"}`;
    const m = (key: keyof typeof VM_METRIC_NAMES) => lastValue(deps.metrics, `${VM_METRIC_NAMES[key]}${sel}`);
    const [
      cpu,
      memUsed,
      memTotal,
      diskUsed,
      diskTotal,
      rx,
      tx,
      conntrack,
      uptime,
      providers,
      all,
      maintenance,
    ] = await Promise.all([
      m('cpuPct'),
      m('memUsedMb'),
      m('memTotalMb'),
      m('diskUsedMb'),
      m('diskTotalMb'),
      m('netRxBps'),
      m('netTxBps'),
      m('conntrackCount'),
      lastValue(deps.metrics, `nodeservice_uptime_sec${sel}`),
      deps.providers.list(),
      deps.incidents.list('all'),
      deps.maintenance.state(s.id),
    ]);
    const mine = all.items.filter((i) => i.serverId === s.id);
    const chk = maintenance.check;
    return {
      content: JSON.stringify({
        id: s.id,
        name: s.name,
        address: `${s.sshUser}@${s.host}:${s.port}`,
        tags: s.tags,
        notes: s.notes,
        provider: providers.find((p) => p.id === s.providerId)?.name ?? null,
        agent: { status: s.agentStatus, version: s.agentVersion, lastSeenAt: s.agentLastSeenAt },
        ssh: { ok: s.sshOk, lastCheckAt: s.lastSshCheckAt, lastOkAt: s.lastSshOkAt },
        node: { watch: NODE_WATCH_LABELS[s.nodeWatch], state: s.node ? NODE_STATE_LABELS[s.node] : null },
        facts: s.facts,
        metrics: {
          cpuPct: cpu,
          memUsedMb: memUsed,
          memTotalMb: memTotal,
          diskUsedMb: diskUsed,
          diskTotalMb: diskTotal,
          netRxBps: rx,
          netTxBps: tx,
          conntrack,
          uptimeSec: uptime,
        },
        openIncidents: mine.filter((i) => i.status !== 'resolved').map(briefIncident),
        recentIncidents: mine
          .filter((i) => i.status === 'resolved')
          .slice(0, 5)
          .map(briefIncident),
        maintenance: chk
          ? {
              checkedAt: chk.checkedAt,
              updates: chk.updates,
              rebootRequired: chk.rebootRequired,
              diskFreeMb: chk.disk.freeMb,
            }
          : null,
      }),
      citations: [{ type: 'server', id: s.id, label: s.name }],
      proposals: [],
    };
  }

  if (name === 'get_metrics_history') {
    const servers = await deps.servers.list();
    const s = findServer(servers, String(arg.serverId ?? ''));
    if (!s) return notFound(servers);
    const metric = String(arg.metric ?? '');
    if (!HISTORY_METRICS.has(metric))
      return none(`Неизвестная метрика. Допустимые: ${[...HISTORY_METRICS].join(', ')}.`);
    const parsed = metricRangeSchema.safeParse(arg.range);
    const range = parsed.success ? parsed.data : '1h';
    const { seconds, stepSeconds } = METRIC_RANGES[range];
    const now = Math.floor(Date.now() / 1000);
    const res = await deps.metrics.queryRange(historyQuery(metric, s.id), now - seconds, now, stepSeconds);
    if (res === null)
      return none(
        'Хранилище метрик (VictoriaMetrics) сейчас недоступно — истории нет. Скажи об этом честно.',
      );
    const summary = summarizeSeries(res[0]?.points ?? []);
    if (!summary)
      return none(
        `За период ${range} данных по «${metric}» нет: агент не присылал метрики или сервер выключен.`,
      );
    return {
      content: JSON.stringify({ server: s.name, metric, unit: UNITS[metric] ?? '', range, ...summary }),
      citations: [{ type: 'metric', id: `${s.id}:${metric}`, label: `${s.name}: ${metric}` }],
      proposals: [],
    };
  }

  if (name === 'list_incidents') {
    const status = arg.status === 'open' || arg.status === 'resolved' ? arg.status : 'all';
    const limitRaw = Number(arg.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(25, Math.floor(limitRaw)) : 10;
    let serverId: string | null = null;
    if (typeof arg.serverId === 'string' && arg.serverId.trim()) {
      const servers = await deps.servers.list();
      const s = findServer(servers, arg.serverId);
      if (!s) return notFound(servers);
      serverId = s.id;
    }
    const res = await deps.incidents.list(status);
    const items = res.items
      .filter((i) => serverId === null || i.serverId === serverId)
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
      .slice(0, limit);
    return {
      content: JSON.stringify({ counts: res.counts, items: items.map(briefIncident) }),
      citations: items.slice(0, 3).map((i) => ({ type: 'incident', id: i.id, label: i.title })),
      proposals: [],
    };
  }

  if (name === 'get_incident') {
    let inc: Incident;
    try {
      inc = await deps.incidents.get(String(arg.incidentId ?? ''));
    } catch {
      return none('Инцидент с таким id не найден. Возьми id из list_incidents.');
    }
    return {
      content: JSON.stringify(incidentCase(inc)),
      citations: [{ type: 'incident', id: inc.id, label: inc.title }],
      proposals: [],
    };
  }

  if (name === 'get_maintenance') {
    const servers = await deps.servers.list();
    const s = findServer(servers, String(arg.serverId ?? ''));
    if (!s) return notFound(servers);
    const st = await deps.maintenance.state(s.id);
    const run = (r: typeof st.lastRun) =>
      r
        ? {
            kind: r.kind,
            status: r.status,
            startedAt: r.startedAt,
            finishedAt: r.finishedAt,
            error: r.error,
            steps: r.steps.map((x) => `${x.label}: ${x.status}${x.detail ? ` (${x.detail})` : ''}`),
          }
        : null;
    return {
      content: JSON.stringify({
        server: s.name,
        check: st.check,
        checkError: st.checkError,
        nextCheckAt: st.nextCheckAt,
        running: run(st.running),
        lastRun: run(st.lastRun),
      }),
      citations: [{ type: 'server', id: s.id, label: s.name }],
      proposals: [],
    };
  }

  return null;
}
