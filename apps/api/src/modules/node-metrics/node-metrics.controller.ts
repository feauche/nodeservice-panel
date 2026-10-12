import { createHash } from 'node:crypto';
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
import { estimateNodeCapacity, type NodeMetrics, remnaTrafficSchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { NodePreferencesStore } from '../remnawave/node-preferences.store.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { getJson, RemnawaveApiError } from '../remnawave/remnawave-client.js';
import { RemnawaveSettingsStore } from '../remnawave/remnawave-settings.store.js';
import { MonitoringStore } from '../settings/monitoring.store.js';
import { NodeMetricHistoryService, parseMetricHistoryRange } from './node-metric-history.service.js';

const PRUNE_EVERY_MS = 10 * 60_000;

@Injectable()
export class NodeMetricsService {
  private readonly log = new Logger(NodeMetricsService.name);
  private historyCache = new Map<
    string,
    { at: number; history: NodeMetrics['history']; since: string | null }
  >();
  private pending: Promise<void> | null = null;
  /** Последний записанный снимок: тот же снимок повторно не пишем — замер этой минуты уже в базе. */
  private recorded: string | null = null;
  /** Старые замеры чистим не на каждом тике, а раз в 10 минут: удаление проходит по всей таблице. */
  private prunedAt = 0;
  private cache = new Map<string, { at: number; traffic: NodeMetrics['traffic']; error: string | null }>();
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
    const t = new Date(Math.floor(Date.parse(status.checkedAt) / 60000) * 60000);
    const inserts = status.nodes.map((n) => {
      const online = n.isConnected && !n.isDisabled;
      const values = {
        cpu: online ? (n.cpuPercent ?? null) : null,
        ram:
          online && n.memoryTotalBytes && n.memoryUsedBytes != null
            ? (n.memoryUsedBytes / n.memoryTotalBytes) * 100
            : null,
        load: online ? (n.loadAverage?.[0] ?? null) : null,
        rx: online ? (n.rxBytesPerSec ?? null) : null,
        tx: online ? (n.txBytesPerSec ?? null) : null,
        online: online ? (n.usersOnline ?? null) : 0,
      };
      return sql`(${domain},${n.uuid},${t.toISOString()},${JSON.stringify(values)}::jsonb)`;
    });
    if (inserts.length)
      await this.db.execute(
        sql`INSERT INTO remna_metric_samples(panel,node_uuid,sampled_at,values) VALUES ${sql.join(inserts, sql`, `)} ON CONFLICT DO NOTHING`,
      );
    this.recorded = snapshot;
    if (Date.now() - this.prunedAt < PRUNE_EVERY_MS) return;
    await this.db.execute(
      sql`DELETE FROM remna_metric_samples WHERE sampled_at < now() - interval '30 days'`,
    );
    this.prunedAt = Date.now();
  }
  async get(minutes: number, days: number): Promise<NodeMetrics> {
    await this.collect();
    const c = await this.store.credentials();
    if (!c) return { panel: null, history: [], traffic: null, trafficError: null, collectedSince: null };
    const local = await this.localHistory(minutes);
    if (local.panel !== c.domain) throw new BadRequestException('Подключение изменилось. Обновите метрики.');
    const end = new Date().toISOString().slice(0, 10),
      start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
    const cacheKey = `${c.domain}:${createHash('sha256').update(c.apiKey).digest('hex')}:${days}`;
    let cached = this.cache.get(cacheKey);
    if (!cached || Date.now() - cached.at > 60000) {
      try {
        const raw = await getJson(
          `https://${c.domain}/api/bandwidth-stats/nodes?start=${start}&end=${end}&topNodesLimit=100`,
          c.apiKey,
        );
        cached = { at: Date.now(), traffic: remnaTrafficSchema.parse(raw.response), error: null };
      } catch (e) {
        cached = {
          at: Date.now(),
          traffic: null,
          error:
            e instanceof RemnawaveApiError && e.kind === 'unauthorized'
              ? 'Для истории трафика ключу требуется разрешение bandwidth-stats:nodes-usage.'
              : 'Не удалось загрузить историю трафика Remnawave.',
        };
      }
      this.cache.clear();
      this.cache.set(cacheKey, cached);
    }
    return {
      panel: c.domain,
      history: local.history,
      traffic: cached.traffic,
      trafficError: cached.error,
      collectedSince: local.since,
    };
  }

  /** Reads persisted samples only: no collection, credentials or external requests. */
  async localHistory(minutes: number) {
    const domain = await this.store.domain();
    if (!domain) return { panel: null, history: [], since: null };
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
      avg((values->>'rx')::float) AS rx, avg((values->>'tx')::float) AS tx, avg((values->>'online')::float) AS online
      FROM (SELECT node_uuid, values, floor(extract(epoch FROM sampled_at)/${bucket})*${bucket} AS bucket_t FROM remna_metric_samples WHERE panel=${domain} AND sampled_at >= ${new Date(Date.now() - minutes * 60000).toISOString()}::timestamptz) samples GROUP BY node_uuid,bucket_t ORDER BY t`);
      const history: NodeMetrics['history'] = [];
      for (const r of rows.rows) {
        let node = history.find((n) => n.uuid === r.uuid);
        if (!node) {
          node = { uuid: String(r.uuid), points: [] };
          history.push(node);
        }
        const num = (x: unknown) => (x == null ? null : Number(x));
        node.points.push({
          t: Number(r.t) * 1000,
          cpu: num(r.cpu),
          ram: num(r.ram),
          load: num(r.load),
          rx: num(r.rx),
          tx: num(r.tx),
          online: num(r.online),
        });
      }
      // Explicit gaps prevent charts from joining across missing/offline intervals.
      const endBucket = Math.floor(Date.now() / (bucket * 1000)) * bucket * 1000;
      for (const node of history) {
        const points = new Map(node.points.map((p) => [p.t, p]));
        const start = node.points[0]?.t ?? endBucket;
        node.points = [];
        for (
          let t = start;
          t <= (points.has(endBucket) ? endBucket : endBucket - bucket * 1000);
          t += bucket * 1000
        ) {
          node.points.push(
            points.get(t) ?? { t, cpu: null, ram: null, load: null, rx: null, tx: null, online: null },
          );
        }
      }
      local = {
        at: Date.now(),
        history,
        since: first.rows[0]?.first ? new Date(String(first.rows[0].first)).toISOString() : null,
      };
      if (this.historyCache.size > 8) this.historyCache.clear();
      this.historyCache.set(historyKey, local);
    }
    return { panel: domain, history: local.history, since: local.since };
  }
}
@Controller('nodes')
export class NodeMetricsController {
  constructor(
    private readonly metrics: NodeMetricsService,
    private readonly remna: RemnawaveService,
    private readonly preferences: NodePreferencesStore,
    private readonly history: NodeMetricHistoryService,
  ) {}
  @Get('capacity') async capacity() {
    const [status, local] = await Promise.all([this.remna.status(), this.metrics.localHistory(20160)]);
    if (local.panel !== status.domain)
      throw new BadRequestException('Подключение изменилось. Обновите страницу.');
    const fresh = !status.error && !!status.checkedAt && Date.now() - Date.parse(status.checkedAt) < 90000;
    const rows = await Promise.all(
      status.nodes.map(async (n) => {
        const prefs = await this.preferences.get(n.uuid);
        const estimate = estimateNodeCapacity(
          local.history.find((h) => h.uuid === n.uuid)?.points ?? [],
          prefs.channelMbps,
        );
        return {
          ...estimate,
          uuid: n.uuid,
          name: n.name,
          online: n.usersOnline ?? null,
          available: fresh && n.isConnected && !n.isDisabled,
          headroom:
            estimate.capacity != null && n.usersOnline != null
              ? Math.max(0, estimate.capacity - n.usersOnline)
              : null,
        };
      }),
    );
    return { rows, calculatedAt: new Date().toISOString() };
  }
  @Get('metrics/history') historyRange(
    @Query('from') from = '',
    @Query('to') to = '',
    @Query('nodes') nodes = '',
    @Query('maxPoints') maxPoints = '400',
  ) {
    return this.history.get(parseMetricHistoryRange(from, to, nodes, maxPoints));
  }
  @Get('metrics') get(@Query('minutes') minutes = '60', @Query('days') days = '30') {
    if (![60, 1440, 10080, 43200].includes(Number(minutes)) || ![1, 7, 30, 90].includes(Number(days)))
      throw new BadRequestException('Неверный период.');
    return this.metrics.get(Number(minutes), Number(days));
  }
}
