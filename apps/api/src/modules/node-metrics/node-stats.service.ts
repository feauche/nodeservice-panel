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
/**
 * Замеры трафика покрывают весь период, если начались не позже его начала с этим запасом: старые замеры удаляются
 * раз в 10 минут, и самый ранний может оказаться на минуту позже начала «30 дней».
 */
const SINCE_SLACK_MS = 2 * 60_000;

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

/** «2026-10-13» — дата момента в поясе панели. */
export function localDate(t: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(t);
}
/** Начало суток `date` в поясе панели, мс (с учётом перехода на летнее время). */
export function localDayStart(date: string, timeZone: string): number {
  const offset = (t: number) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
        .formatToParts(t)
        .map((x) => [x.type, x.value]),
    );
    const n = (k: string) => Number(p[k] ?? 0);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - t;
  };
  const guess = Date.parse(`${date}T00:00:00Z`);
  return guess - offset(guess - offset(guess));
}
/** Следующая дата: «2026-10-13» → «2026-10-14». */
function nextDate(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}
/** Дата по Гринвичу — так Remnawave называет свои сутки. */
const utcDate = (t: number) => new Date(t).toISOString().slice(0, 10);
/** Даты с `first` по `last` включительно. */
function datesBetween(first: string, last: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${first}T12:00:00Z`); t <= Date.parse(`${last}T12:00:00Z`); t += DAY_MS)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Отчёт вкладки «Статистика». Трафик — трафик пользователей, как в Remnawave: панель каждую минуту читает счётчик
 * трафика ноды и складывает разницу по суткам своего пояса; сутки до начала замеров — суточные итоги Remnawave.
 * Онлайн, время на связи, часы пика — по замерам панели; сбои — по событиям.
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
      traffic: { total: null, days: [], measuredSince: null, removed: 0, error: null },
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
    const [first, snapshots, heat, perNode, measured, measuredFrom, incidents] = await Promise.all([
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
      // Трафик пользователей по суткам пояса панели и нодам — разница счётчика Remnawave между замерами. Сутки по
      // Гринвичу — чтобы на стыке с итогами Remnawave взять только то, чего в них нет.
      this.db.execute(sql`SELECT to_char(sampled_at AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
          to_char(sampled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS utc_day, node_uuid AS uuid,
          sum((values->>'usedBytes')::float) AS bytes
        FROM remna_metric_samples WHERE panel=${domain} AND sampled_at >= ${fromIso}::timestamptz AND sampled_at < ${toIso}::timestamptz
          AND values->>'usedBytes' IS NOT NULL
        GROUP BY 1, 2, 3`),
      this.db.execute(
        sql`SELECT min(sampled_at) AS since FROM remna_metric_samples WHERE panel=${domain} AND values ? 'usedBytes'`,
      ),
      this.db.execute(sql`SELECT node_uuid, opened_at, resolved_at FROM incidents
        WHERE opened_at < ${toIso}::timestamptz AND (resolved_at IS NULL OR resolved_at > ${fromIso}::timestamptz)`),
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

    // Трафик пользователей — ровно за период [from, to), как онлайн: первые и последние сутки периода неполные.
    // Панель считает его сама каждую минуту. Пока её замеры не покрывают весь период, начало берётся из суточных
    // итогов Remnawave (её сутки — по Гринвичу): целые сутки, начавшиеся внутри периода, до первой полуночи по Гринвичу
    // после начала замеров; с этой полуночи считает панель. Так нет ни двойного счёта, ни дыры на стыке, а первые
    // сутки периода, попавшие в него лишь частью, целым итогом Remnawave не заменяются — период не длиннее выбранного.
    const since = measuredFrom.rows[0]?.since ? new Date(String(measuredFrom.rows[0].since)).getTime() : null;
    const allPanel = since != null && since <= from + SINCE_SLACK_MS;
    const cutover = allPanel
      ? from
      : since == null
        ? Number.POSITIVE_INFINITY
        : Math.ceil(since / DAY_MS) * DAY_MS;
    const cutoverDay = Number.isFinite(cutover) ? utcDate(cutover) : null;
    const byDay = new Map<string, Map<string, number>>();
    for (const r of measured.rows) {
      if (!allPanel && (cutoverDay == null || String(r.utc_day) < cutoverDay)) continue;
      const day = byDay.get(String(r.day)) ?? new Map<string, number>();
      day.set(String(r.uuid), (day.get(String(r.uuid)) ?? 0) + (num(r.bytes) ?? 0));
      byDay.set(String(r.day), day);
    }
    const remoteDays: number[] = [];
    for (let u = Math.ceil(from / DAY_MS) * DAY_MS; u < to && u + DAY_MS <= cutover; u += DAY_MS)
      remoteDays.push(u);
    const firstDay = remoteDays[0];
    const lastDay = remoteDays.at(-1);
    const remote =
      firstDay != null && lastDay != null ? await this.traffic(utcDate(firstDay), utcDate(lastDay)) : null;
    const tr = remote?.traffic ?? null;
    type Bar = { date: string; total: number; source: 'panel' | 'remnawave'; start: number; end: number };
    const bars = new Map<string, Bar>();
    const perNodeTraffic = new Map<string, number>();
    const count = (uuid: string, bytes: number) =>
      perNodeTraffic.set(uuid, (perNodeTraffic.get(uuid) ?? 0) + bytes);
    for (const u of remoteDays) {
      const date = utcDate(u);
      const i = tr?.categories.findIndex((c) => c.slice(0, 10) === date) ?? -1;
      if (!tr || i < 0) continue;
      let total = 0;
      for (const series of tr.series) {
        const bytes = series.data[i] ?? 0;
        total += bytes;
        count(series.uuid, bytes);
      }
      const end = Math.min(u + DAY_MS, to);
      bars.set(date, {
        date,
        total: Math.max(total, tr.sparklineData[i] ?? 0),
        source: 'remnawave',
        start: u,
        end,
      });
    }
    const panelFrom = Math.max(from, cutover);
    if (panelFrom < to)
      for (const date of datesBetween(localDate(panelFrom, timeZone), localDate(to - 1, timeZone))) {
        let total = 0;
        for (const [uuid, bytes] of byDay.get(date) ?? []) {
          total += bytes;
          count(uuid, bytes);
        }
        const end = Math.min(localDayStart(nextDate(date), timeZone), to);
        // Западнее Гринвича сутки на стыке — и итог Remnawave, и замеры панели после полуночи по Гринвичу: один столбик.
        const joint = bars.get(date);
        bars.set(
          date,
          joint
            ? { ...joint, total: joint.total + total, end }
            : {
                date,
                total,
                source: 'panel',
                start: Math.max(localDayStart(date, timeZone), panelFrom),
                end,
              },
        );
      }
    const trafficDays: NodeStats['traffic']['days'] = [...bars.values()]
      .sort((a, b) => a.start - b.start)
      .map(({ start, end, ...d }) => ({
        ...d,
        from: new Date(start).toISOString(),
        to: new Date(end).toISOString(),
      }));
    const trafficTotal = trafficDays.length ? trafficDays.reduce((sum, d) => sum + d.total, 0) : null;
    const current = new Set(status.nodes.map((n) => n.uuid));
    const removed = Math.max(
      0,
      (trafficTotal ?? 0) -
        [...perNodeTraffic].filter(([uuid]) => current.has(uuid)).reduce((sum, [, b]) => sum + b, 0),
    );
    const nodeStats = new Map(perNode.rows.map((r) => [String(r.uuid), r]));

    return {
      ...empty,
      collectedSince: first.rows[0]?.first ? new Date(String(first.rows[0].first)).toISOString() : null,
      traffic: {
        total: trafficTotal,
        days: trafficDays,
        measuredSince: since == null ? null : new Date(since).toISOString(),
        removed,
        error: remote?.error ?? null,
      },
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
        const t = perNodeTraffic.get(n.uuid) ?? null;
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

  /** Суточные итоги Remnawave за даты start…end; удачный ответ кэшируется на минуту, ошибка — нет. */
  private async traffic(start: string, end: string): Promise<Traffic> {
    const c = await this.store.credentials();
    if (!c || !start || !end) return { traffic: null, error: null };
    const key = `${c.domain}:${createHash('sha256').update(c.apiKey).digest('hex')}:${start}:${end}`;
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
    // Ошибку не запоминаем: следующий запрос пробует снова, а не показывает её ещё минуту.
    if (!next.error) this.trafficCache.set(key, next);
    return next;
  }
}
