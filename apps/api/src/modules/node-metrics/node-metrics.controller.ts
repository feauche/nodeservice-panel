import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Injectable,
  Logger,
  Optional,
  Query,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CAPACITY_DAYS, NODE_STATS_DAYS, type NodeCapacity, type NodeMetrics } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { NodePreferencesStore } from '../remnawave/node-preferences.store.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { RemnawaveSettingsStore } from '../remnawave/remnawave-settings.store.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { bridgeSingleGaps, fillPoint, fleetSeries, mean2, UP_SQL } from './metric-buckets.js';
import { type CapacityPoint, estimateCapacity } from './node-capacity.logic.js';
import { NodeMetricHistoryService, parseMetricHistoryRange } from './node-metric-history.service.js';
import { NodeStatsService } from './node-stats.service.js';

/** Замер в базу — не чаще раза в минуту (чуть меньше, чтобы опоздавший опрос не пропускал минуту). */
const RECORD_EVERY_MS = 55_000;
const PRUNE_EVERY_MS = 10 * 60_000;

type LocalHistory = {
  at: number;
  history: NodeMetrics['history'];
  since: string | null;
  bucket: number;
  /** Доля времени на связи по нодам и корзинам: для числа нод на связи в сумме по парку. */
  up: Map<string, Map<number, number>>;
};

@Injectable()
export class NodeMetricsService {
  private readonly log = new Logger(NodeMetricsService.name);
  private historyCache = new Map<string, LocalHistory>();
  private typicalCache: {
    key: string;
    at: number;
    value: Pick<NodeMetrics, 'onlineTypical' | 'onlineTypicalByNode'>;
  } | null = null;
  private pending: Promise<void> | null = null;
  /** Последний записанный снимок: тот же снимок повторно не пишем — его замер уже в базе. */
  private recorded: string | null = null;
  /** Время и подключение последнего записанного замера: замеры — не чаще раза в минуту. */
  private recordedAt = 0;
  private recordedDomain: string | null = null;
  /** Старые замеры чистим не на каждом тике, а раз в 10 минут: удаление проходит по всей таблице. */
  private prunedAt = 0;
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RemnawaveSettingsStore,
    private readonly remna: RemnawaveService,
    @Optional() private readonly monitoring?: MonitoringStore,
  ) {}
  @Interval(15000) async tick() {
    if (process.env.NODE_ENV !== 'test')
      await this.collect().catch(() =>
        this.log.warn('Не удалось сохранить замеры Remnawave. Проверьте подключение к базе данных.'),
      );
  }
  async collect() {
    if (this.pending) return this.pending;
    this.pending = this.record();
    try {
      await this.pending;
    } finally {
      this.pending = null;
    }
  }
  private async record() {
    const domain = await this.store.domain();
    if (!domain) return;
    // Polling belongs to RemnawaveSyncJob and the explicit node refresh path.
    // Persist the snapshot's actual timestamp; stale data must not become a new measurement.
    const status = await this.remna.status();
    if (status.domain !== domain || status.error || !status.checkedAt) return;
    const snapshot = `${domain}:${status.checkedAt}`;
    if (snapshot === this.recorded) return;
    // Опрос теперь каждые 15 секунд, а графикам хватает замера в минуту: чаще писать — раздувать базу вчетверо.
    const at = Date.parse(status.checkedAt);
    if (this.recordedDomain === domain && at - this.recordedAt < RECORD_EVERY_MS) return;
    // Точное время снимка, а не начало минуты: два снимка в одной минуте больше не вытесняют друг друга,
    // и у соседней минуты не появляется ложный пропуск. Все ноды одного снимка получают одно время.
    const t = new Date(Date.parse(status.checkedAt));
    const inserts = status.nodes.map((n) => {
      const online = n.isConnected && !n.isDisabled;
      // Нода не на связи или выключена: в сумме онлайна и трафика она даёт ноль, в среднем памяти и нагрузки
      // не участвует (там пусто).
      const values = {
        cpu: online ? (n.cpuPercent ?? null) : null,
        ram:
          online && n.memoryTotalBytes && n.memoryUsedBytes != null
            ? (n.memoryUsedBytes / n.memoryTotalBytes) * 100
            : null,
        load: online ? (n.loadAverage?.[0] ?? null) : null,
        rx: online ? (n.rxBytesPerSec ?? null) : 0,
        tx: online ? (n.txBytesPerSec ?? null) : 0,
        online: online ? (n.usersOnline ?? null) : 0,
        up: online ? 1 : 0,
      };
      return sql`(${domain},${n.uuid},${t.toISOString()},${JSON.stringify(values)}::jsonb)`;
    });
    if (inserts.length)
      await this.db.execute(
        sql`INSERT INTO remna_metric_samples(panel,node_uuid,sampled_at,values) VALUES ${sql.join(inserts, sql`, `)} ON CONFLICT DO NOTHING`,
      );
    this.recorded = snapshot;
    this.recordedAt = at;
    this.recordedDomain = domain;
    if (Date.now() - this.prunedAt < PRUNE_EVERY_MS) return;
    await this.db.execute(
      sql`DELETE FROM remna_metric_samples WHERE sampled_at < now() - interval '30 days'`,
    );
    this.prunedAt = Date.now();
  }
  /** Метрики за последние `minutes` минут: по нодам и весь парк (сумма считается здесь, а не в браузере). */
  async get(minutes: number): Promise<NodeMetrics> {
    await this.collect();
    const local = await this.localData(minutes);
    if (!local)
      return {
        panel: null,
        bucketSeconds: 60,
        history: [],
        fleet: [],
        onlineTypical: null,
        onlineTypicalByNode: {},
        collectedSince: null,
      };
    return {
      panel: local.panel,
      bucketSeconds: local.bucket,
      history: local.history,
      fleet: fleetSeries(local.history, local.up),
      ...(await this.onlineTypical(local.panel)),
      collectedSince: local.since,
    };
  }

  /** Reads persisted samples only: no collection, credentials or external requests. */
  async localHistory(minutes: number) {
    const local = await this.localData(minutes);
    return local
      ? { panel: local.panel, history: local.history, since: local.since }
      : { panel: null, history: [], since: null };
  }

  private async localData(minutes: number): Promise<(LocalHistory & { panel: string }) | null> {
    const domain = await this.store.domain();
    if (!domain) return null;
    const historyKey = `${domain}:${minutes}`;
    let local = this.historyCache.get(historyKey);
    if (!local || Date.now() - local.at >= 60000) {
      const first = await this.db.execute(
        sql`SELECT min(sampled_at) AS first FROM remna_metric_samples WHERE panel=${domain}`,
      );
      const since = first.rows[0]?.first ? new Date(String(first.rows[0].first)).getTime() : Date.now();
      const span = Math.min(minutes * 60, Math.max(60, (Date.now() - since) / 1000));
      const pollSeconds = this.monitoring ? (await this.monitoring.get()).pollSeconds : 60;
      const bucket = Math.max(Math.ceil(pollSeconds / 60) * 60, Math.ceil(span / 240 / 60) * 60);
      const rows = await this.db.execute(sql`SELECT node_uuid AS uuid, bucket_t AS t,
      avg((values->>'cpu')::float) AS cpu, avg((values->>'ram')::float) AS ram, avg((values->>'load')::float) AS load,
      avg((values->>'rx')::float) AS rx, avg((values->>'tx')::float) AS tx, avg((values->>'online')::float) AS online,
      avg(${UP_SQL}) AS up
      FROM (SELECT node_uuid, values, floor(extract(epoch FROM sampled_at)/${bucket})*${bucket} AS bucket_t FROM remna_metric_samples WHERE panel=${domain} AND sampled_at >= ${new Date(Date.now() - minutes * 60000).toISOString()}::timestamptz) samples GROUP BY node_uuid,bucket_t ORDER BY t`);
      const history: NodeMetrics['history'] = [];
      const up = new Map<string, Map<number, number>>();
      for (const r of rows.rows) {
        let node = history.find((n) => n.uuid === r.uuid);
        if (!node) {
          node = { uuid: String(r.uuid), points: [] };
          history.push(node);
        }
        const num = (x: unknown) => (x == null ? null : Number(x));
        const t = Number(r.t) * 1000;
        node.points.push({
          t,
          cpu: num(r.cpu),
          ram: num(r.ram),
          load: num(r.load),
          rx: num(r.rx),
          tx: num(r.tx),
          online: num(r.online),
        });
        const byT = up.get(node.uuid) ?? new Map<number, number>();
        byT.set(t, Number(r.up) || 0);
        up.set(node.uuid, byT);
      }
      // Пустые корзины явно: график не соединяет линию через настоящий перерыв. Одиночный пропуск дорисован.
      const endBucket = Math.floor(Date.now() / (bucket * 1000)) * bucket * 1000;
      for (const node of history) {
        const points = new Map(node.points.map((p) => [p.t, p]));
        const start = node.points[0]?.t ?? endBucket;
        const grid: NodeMetrics['history'][number]['points'] = [];
        for (
          let t = start;
          t <= (points.has(endBucket) ? endBucket : endBucket - bucket * 1000);
          t += bucket * 1000
        ) {
          grid.push(
            points.get(t) ?? { t, cpu: null, ram: null, load: null, rx: null, tx: null, online: null },
          );
        }
        const byT = up.get(node.uuid);
        node.points = bridgeSingleGaps(grid, (prev, next, gap) => {
          byT?.set(gap.t, mean2(byT.get(prev.t) ?? null, byT.get(next.t) ?? null) ?? 0);
          return fillPoint(prev, next, gap);
        });
      }
      local = {
        at: Date.now(),
        history,
        since: first.rows[0]?.first ? new Date(String(first.rows[0].first)).toISOString() : null,
        bucket,
        up,
      };
      if (this.historyCache.size > 8) this.historyCache.clear();
      this.historyCache.set(historyKey, local);
    }
    return { ...local, panel: domain };
  }

  /**
   * Обычный онлайн в этот час суток — у парка и у каждой ноды: 10-й и 90-й процентили замеров за 7 дней в тот же
   * час. Меньше трёх дней истории — не знаем, что обычно.
   */
  private async onlineTypical(
    domain: string,
  ): Promise<Pick<NodeMetrics, 'onlineTypical' | 'onlineTypicalByNode'>> {
    const hour = new Date().getUTCHours();
    const key = `${domain}:${hour}`;
    if (this.typicalCache?.key === key && Date.now() - this.typicalCache.at < 5 * 60_000)
      return this.typicalCache.value;
    const window = sql`panel=${domain} AND sampled_at >= now() - interval '7 days' AND sampled_at < now() - interval '1 hour'
      AND extract(hour FROM sampled_at AT TIME ZONE 'UTC') = ${hour}`;
    const [fleet, nodes] = await Promise.all([
      this.db.execute(sql`WITH snaps AS (
          SELECT sampled_at, sum((values->>'online')::float) AS total FROM remna_metric_samples
          WHERE ${window} GROUP BY sampled_at)
        SELECT percentile_cont(0.1) WITHIN GROUP (ORDER BY total) AS low,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY total) AS high,
          count(DISTINCT (sampled_at AT TIME ZONE 'UTC')::date) AS days
        FROM snaps`),
      this.db.execute(sql`SELECT node_uuid AS uuid,
          percentile_cont(0.1) WITHIN GROUP (ORDER BY (values->>'online')::float) AS low,
          percentile_cont(0.9) WITHIN GROUP (ORDER BY (values->>'online')::float) AS high,
          count(DISTINCT (sampled_at AT TIME ZONE 'UTC')::date) AS days
        FROM remna_metric_samples WHERE ${window} AND values->>'online' IS NOT NULL GROUP BY node_uuid`),
    ]);
    const range = (row: Record<string, unknown> | undefined) => {
      const low = Number(row?.low);
      const high = Number(row?.high);
      if (!row || Number(row.days) < 3 || !Number.isFinite(low) || !Number.isFinite(high)) return null;
      const step = (v: number) => (v >= 1000 ? 100 : v >= 100 ? 10 : 1);
      return {
        low: Math.floor(low / step(low)) * step(low),
        high: Math.ceil(high / step(high)) * step(high),
      };
    };
    const byNode: NodeMetrics['onlineTypicalByNode'] = {};
    for (const row of nodes.rows) {
      const r = range(row);
      if (r) byNode[String(row.uuid)] = r;
    }
    const value = { onlineTypical: range(fleet.rows[0]), onlineTypicalByNode: byNode };
    this.typicalCache = { key, at: Date.now(), value };
    return value;
  }

  /** Замеры для «Ёмкости»: корзины по 15 минут за последние две недели, по нодам. */
  async capacityPoints(domain: string): Promise<Map<string, CapacityPoint[]>> {
    const rows =
      await this.db.execute(sql`SELECT node_uuid AS uuid, floor(extract(epoch FROM sampled_at)/900)*900 AS t,
      avg((values->>'online')::float) AS online, avg((values->>'ram')::float) AS ram, avg((values->>'load')::float) AS load,
      avg((values->>'rx')::float) AS rx, avg((values->>'tx')::float) AS tx
      FROM remna_metric_samples WHERE panel=${domain} AND sampled_at >= ${new Date(Date.now() - CAPACITY_DAYS * 86_400_000).toISOString()}::timestamptz
      GROUP BY 1, 2 ORDER BY 2`);
    const num = (x: unknown) => (x == null ? null : Number(x));
    const out = new Map<string, CapacityPoint[]>();
    for (const r of rows.rows) {
      const list = out.get(String(r.uuid)) ?? [];
      list.push({
        t: Number(r.t) * 1000,
        online: num(r.online),
        ram: num(r.ram),
        load: num(r.load),
        rx: num(r.rx),
        tx: num(r.tx),
      });
      out.set(String(r.uuid), list);
    }
    return out;
  }
}
@Controller('nodes')
export class NodeMetricsController {
  constructor(
    private readonly metrics: NodeMetricsService,
    private readonly remna: RemnawaveService,
    private readonly preferences: NodePreferencesStore,
    private readonly history: NodeMetricHistoryService,
    private readonly stats: NodeStatsService,
  ) {}
  @Get('capacity') async capacity(): Promise<NodeCapacity> {
    const status = await this.remna.status();
    const points = status.domain ? await this.metrics.capacityPoints(status.domain) : new Map();
    const rows = await Promise.all(
      status.nodes.map(async (n) => {
        const prefs = await this.preferences.get(n.uuid);
        const cores = n.cpuCount ?? null;
        return {
          uuid: n.uuid,
          name: n.name,
          countryCode: n.countryCode,
          cores,
          channelMbps: prefs.channelMbps,
          ...estimateCapacity(points.get(n.uuid) ?? [], {
            cores,
            channelMbps: prefs.channelMbps,
            disabled: n.isDisabled,
          }),
        };
      }),
    );
    return { rows, calculatedAt: new Date().toISOString() };
  }
  @Get('stats') statsGet(@Query('days') days = '30') {
    const n = Number(days);
    if (!(NODE_STATS_DAYS as readonly number[]).includes(n))
      throw new BadRequestException('Неверный период.');
    return this.stats.get(n);
  }
  @Get('metrics/history') historyRange(
    @Query('from') from = '',
    @Query('to') to = '',
    @Query('nodes') nodes = '',
    @Query('maxPoints') maxPoints = '400',
  ) {
    return this.history.get(parseMetricHistoryRange(from, to, nodes, maxPoints));
  }
  @Get('metrics') get(@Query('minutes') minutes = '60') {
    if (![60, 1440, 10080, 43200].includes(Number(minutes)))
      throw new BadRequestException('Неверный период.');
    return this.metrics.get(Number(minutes));
  }
}
