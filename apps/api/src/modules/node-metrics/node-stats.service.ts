import { createHash } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { type NodeStats, remnaTrafficSchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { DEFAULT_TIME_ZONE, panelTimeZone } from '../../common/panel-time-zone.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { RemnawaveService } from '../remnawave/remnawave.service.js';
import { getJson, RemnawaveApiError } from '../remnawave/remnawave-client.js';
import { RemnawaveSettingsStore } from '../remnawave/remnawave-settings.store.js';
import { bridgeSingleGaps, mean2, UP_SQL } from './metric-buckets.js';

const DAY_MS = 86_400_000;
/** Шаг графика онлайна: сутки — 15 минут, неделя — час, 30 дней — 4 часа (около 180 точек). */
const ONLINE_BUCKET_SECONDS: Record<number, number> = { 1: 900, 7: 3600, 30: 14_400 };
/** Онлайн по часам суток — средний за последние четыре недели. */
const HEATMAP_DAYS = 28;
/** Окно пика и тишины, часы. */
const WINDOW_HOURS = 4;

type Traffic = { traffic: ReturnType<typeof remnaTrafficSchema.parse> | null; error: string | null };

/** Четыре часа подряд (через полночь тоже) с наибольшей или наименьшей суммой средних по часам. */
export function hourWindow(hourly: Array<number | null>, best: 'max' | 'min') {
  if (hourly.every((v) => v == null)) return null;
  let pick: { from: number; sum: number } | null = null;
  for (let from = 0; from < 24; from += 1) {
    const cells = Array.from({ length: WINDOW_HOURS }, (_, i) => hourly[(from + i) % 24]);
    if (cells.some((v) => v == null)) continue;
    const sum = cells.reduce<number>((s, v) => s + (v ?? 0), 0);
    if (!pick || (best === 'max' ? sum > pick.sum : sum < pick.sum)) pick = { from, sum };
  }
  return pick ? { from: pick.from, to: (pick.from + WINDOW_HOURS) % 24 } : null;
}

/**
 * Простой внутри периода, мс: по каждой ноде время её событий объединяется (три события об одной ноде в один час —
 * это час, а не три), затем складывается по нодам. Открытое событие длится до конца периода.
 */
export function downtimeWithin(
  rows: Array<{ node: string | null; openedAt: number; resolvedAt: number | null }>,
  from: number,
  to: number,
) {
  const byNode = new Map<string, Array<[number, number]>>();
  rows.forEach((r, i) => {
    const start = Math.max(r.openedAt, from);
    const end = Math.min(r.resolvedAt ?? to, to);
    if (end <= start) return;
    const key = r.node ?? `без ноды:${i}`;
    byNode.set(key, [...(byNode.get(key) ?? []), [start, end]]);
  });
  let total = 0;
  for (const spans of byNode.values()) {
    spans.sort((a, b) => a[0] - b[0]);
    let [curStart, curEnd] = spans[0] ?? [0, 0];
    for (const [start, end] of spans.slice(1)) {
      if (start <= curEnd) curEnd = Math.max(curEnd, end);
      else {
        total += curEnd - curStart;
        [curStart, curEnd] = [start, end];
      }
    }
    total += curEnd - curStart;
  }
  return total;
}

/**
 * Отчёт вкладки «Статистика». Трафик — из Remnawave (он считает его сам, по дням UTC); онлайн, время на связи,
 * часы пика — по замерам панели; сбои — по событиям. Всё читается из базы, кроме трафика (кэш на минуту).
 */
@Injectable()
export class NodeStatsService {
  private trafficCache = new Map<string, { at: number } & Traffic>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RemnawaveSettingsStore,
    private readonly remna: RemnawaveService,
  ) {}

  async get(days: number): Promise<NodeStats> {
    const [domain, status] = await Promise.all([this.store.domain(), this.remna.status()]);
    if (domain !== status.domain) throw new BadRequestException('Подключение изменилось. Обновите страницу.');
    const timeZone = (await panelTimeZone(this.db)) ?? DEFAULT_TIME_ZONE;
    const to = Date.now();
    const from = to - days * DAY_MS;
    const bucket = ONLINE_BUCKET_SECONDS[days] ?? 3600;
    const empty: NodeStats = {
      panel: domain,
      days,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      timeZone,
      collectedSince: null,
      traffic: { total: null, days: [], error: null },
      online: { peak: null, peakAt: null, average: null, minimum: null, bucketSeconds: bucket, series: [] },
      heatmap: {
        cells: Array.from({ length: 7 }, () => Array(24).fill(null)),
        days: 0,
        peak: null,
        quiet: null,
      },
      incidents: { count: 0, downtimeMs: 0 },
      nodes: [],
    };
    if (!domain) return empty;
    const fromIso = new Date(from).toISOString();
    const toIso = new Date(to).toISOString();
    const heatFrom = new Date(to - HEATMAP_DAYS * DAY_MS).toISOString();
    const [first, snapshots, heat, perNode, perDay, incidents, traffic] = await Promise.all([
      this.db.execute(sql`SELECT min(sampled_at) AS first FROM remna_metric_samples WHERE panel=${domain}`),
      // Один снимок Remnawave — один момент времени у всех нод: сумма по нему и есть онлайн парка.
      this.db.execute(sql`SELECT extract(epoch FROM sampled_at) AS t, sum((values->>'online')::float) AS total
        FROM remna_metric_samples WHERE panel=${domain} AND sampled_at >= ${fromIso}::timestamptz AND sampled_at < ${toIso}::timestamptz
        GROUP BY sampled_at ORDER BY sampled_at`),
      this.db.execute(sql`WITH snaps AS (
          SELECT sampled_at AT TIME ZONE ${timeZone} AS local, sum((values->>'online')::float) AS total
          FROM remna_metric_samples WHERE panel=${domain} AND sampled_at >= ${heatFrom}::timestamptz
          GROUP BY sampled_at)
        SELECT extract(isodow FROM local)::int AS dow, extract(hour FROM local)::int AS hour, avg(total) AS v,
          (SELECT count(DISTINCT local::date) FROM snaps) AS days
        FROM snaps GROUP BY 1, 2`),
      this.db.execute(sql`SELECT node_uuid AS uuid, max((values->>'online')::float) AS peak, avg(${UP_SQL}) AS up
        FROM remna_metric_samples WHERE panel=${domain} AND sampled_at >= ${fromIso}::timestamptz AND sampled_at < ${toIso}::timestamptz
        GROUP BY node_uuid`),
      this.db.execute(sql`SELECT to_char(sampled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
          sum((values->>'rx')::float) AS rx, sum((values->>'tx')::float) AS tx
        FROM remna_metric_samples WHERE panel=${domain} AND sampled_at >= ${new Date(to - (days + 1) * DAY_MS).toISOString()}::timestamptz
        GROUP BY 1`),
      this.db.execute(sql`SELECT node_uuid, opened_at, resolved_at FROM incidents
        WHERE opened_at < ${toIso}::timestamptz AND (resolved_at IS NULL OR resolved_at > ${fromIso}::timestamptz)`),
      this.traffic(days),
    ]);
    const num = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

    // Онлайн за период: пик, минимум и среднее по снимкам; график — средний онлайн в корзине.
    const snaps = snapshots.rows.flatMap((r) => {
      const t = num(r.t);
      const v = num(r.total);
      return t == null || v == null ? [] : [{ t: t * 1000, v }];
    });
    let peak: { t: number; v: number } | null = null;
    let minimum: number | null = null;
    for (const s of snaps) {
      if (!peak || s.v > peak.v) peak = s;
      minimum = minimum == null ? s.v : Math.min(minimum, s.v);
    }
    const buckets = new Map<number, { sum: number; n: number }>();
    for (const s of snaps) {
      const t = Math.floor(s.t / (bucket * 1000)) * bucket * 1000;
      const b = buckets.get(t) ?? { sum: 0, n: 0 };
      b.sum += s.v;
      b.n += 1;
      buckets.set(t, b);
    }
    const series: Array<{ t: number; v: number | null }> = [];
    const firstBucket = Math.floor(from / (bucket * 1000)) * bucket * 1000;
    for (let t = firstBucket; t <= to; t += bucket * 1000) {
      const b = buckets.get(t);
      series.push({ t, v: b ? b.sum / b.n : null });
    }
    const bridged = bridgeSingleGaps(
      series.map((p) => ({ ...p, cpu: null, ram: null, load: null, rx: null, tx: null, online: p.v })),
      (prev, next, gap) => ({ ...gap, online: mean2(prev.online, next.online) }),
    ).map((p) => ({ t: p.t, v: p.online }));
    // Начало графика — с первой корзины, где есть данные: пустое начало периода — не «нет данных», а «ещё не собирали».
    const startAt = bridged.findIndex((p) => p.v != null);

    // Онлайн по часам суток.
    const cells: Array<Array<number | null>> = Array.from({ length: 7 }, () => Array(24).fill(null));
    let heatDays = 0;
    for (const r of heat.rows) {
      const dow = Number(r.dow);
      const hour = Number(r.hour);
      const v = num(r.v);
      heatDays = Number(r.days) || heatDays;
      const row = cells[dow - 1];
      if (row && hour >= 0 && hour < 24) row[hour] = v == null ? null : Math.round(v);
    }
    const hourly = Array.from({ length: 24 }, (_, h) => {
      const vs = cells.map((row) => row[h]).filter((v): v is number => v != null);
      return vs.length ? vs.reduce((s, v) => s + v, 0) / vs.length : null;
    });

    // Сбои.
    const incidentRows = incidents.rows.map((r) => ({
      node: r.node_uuid == null ? null : String(r.node_uuid),
      openedAt: new Date(String(r.opened_at)).getTime(),
      resolvedAt: r.resolved_at ? new Date(String(r.resolved_at)).getTime() : null,
    }));
    const openedInRange = incidentRows.filter((r) => r.openedAt >= from);

    // Трафик: всего — Remnawave; приём и отдача — его доля по замерам панели в тот же день UTC.
    const split = new Map(
      perDay.rows.map((r) => [String(r.day), { rx: num(r.rx) ?? 0, tx: num(r.tx) ?? 0 }]),
    );
    const tr = traffic.traffic;
    const trafficDays =
      tr?.categories.map((date, i) => {
        const total = tr.sparklineData[i] ?? 0;
        const share = split.get(date.slice(0, 10));
        const both = share ? share.rx + share.tx : 0;
        return {
          date: date.slice(0, 10),
          total,
          rx: share && both > 0 ? (total * share.rx) / both : null,
          tx: share && both > 0 ? (total * share.tx) / both : null,
        };
      }) ?? [];
    const trafficTotal = tr ? tr.sparklineData.reduce((s, v) => s + v, 0) : null;
    const nodeTraffic = new Map(tr?.series.map((s) => [s.uuid, s.total]) ?? []);
    const nodeStats = new Map(perNode.rows.map((r) => [String(r.uuid), r]));

    return {
      ...empty,
      collectedSince: first.rows[0]?.first ? new Date(String(first.rows[0].first)).toISOString() : null,
      traffic: { total: trafficTotal, days: trafficDays, error: traffic.error },
      online: {
        peak: peak ? Math.round(peak.v) : null,
        peakAt: peak ? new Date(peak.t).toISOString() : null,
        average: snaps.length ? Math.round(snaps.reduce((s, x) => s + x.v, 0) / snaps.length) : null,
        minimum: minimum == null ? null : Math.round(minimum),
        bucketSeconds: bucket,
        series: startAt < 0 ? [] : bridged.slice(startAt),
      },
      heatmap: { cells, days: heatDays, peak: hourWindow(hourly, 'max'), quiet: hourWindow(hourly, 'min') },
      incidents: { count: openedInRange.length, downtimeMs: downtimeWithin(incidentRows, from, to) },
      nodes: status.nodes.map((n) => {
        const row = nodeStats.get(n.uuid);
        const t = nodeTraffic.get(n.uuid) ?? null;
        const up = num(row?.up);
        return {
          uuid: n.uuid,
          name: n.name,
          countryCode: n.countryCode,
          disabled: n.isDisabled,
          traffic: t,
          share: t != null && trafficTotal ? (t / trafficTotal) * 100 : null,
          peakOnline: num(row?.peak) == null ? null : Math.round(Number(row?.peak)),
          uptime: up == null ? null : Math.round(up * 1000) / 10,
          incidents: openedInRange.filter((r) => r.node === n.uuid).length,
        };
      }),
    };
  }

  /** Трафик по дням из Remnawave; ответ кэшируется на минуту. */
  private async traffic(days: number): Promise<Traffic> {
    const c = await this.store.credentials();
    if (!c) return { traffic: null, error: null };
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - (days - 1) * DAY_MS).toISOString().slice(0, 10);
    const key = `${c.domain}:${createHash('sha256').update(c.apiKey).digest('hex')}:${days}`;
    const cached = this.trafficCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached;
    let next: { at: number } & Traffic;
    try {
      const raw = await getJson(
        `https://${c.domain}/api/bandwidth-stats/nodes?start=${start}&end=${end}&topNodesLimit=100`,
        c.apiKey,
      );
      next = { at: Date.now(), traffic: remnaTrafficSchema.parse(raw.response), error: null };
    } catch (e) {
      next = {
        at: Date.now(),
        traffic: null,
        error:
          e instanceof RemnawaveApiError && e.kind === 'unauthorized'
            ? 'Ключу Remnawave не хватает разрешения на статистику трафика нод.'
            : 'Не удалось загрузить трафик из Remnawave.',
      };
    }
    if (this.trafficCache.size > 8) this.trafficCache.clear();
    this.trafficCache.set(key, next);
    return next;
  }
}
