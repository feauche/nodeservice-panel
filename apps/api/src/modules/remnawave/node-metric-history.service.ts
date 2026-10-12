import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { type NodeMetricHistory, tcpCheckReportSchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { RemnawaveService } from './remnawave.service.js';
import { RemnawaveSettingsStore } from './remnawave-settings.store.js';

const fields = ['cpu', 'ram', 'load', 'rx', 'tx', 'online'] as const;
const empty = () => ({ cpu: null, ram: null, load: null, rx: null, tx: null, online: null });
export function parseMetricHistoryRange(from: string, to: string, nodes = '', maxPoints = '400') {
  // Reject ambiguous date-only/local datetime strings. Offset-qualified instants work in every timezone.
  const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
  const start = Date.parse(from),
    end = Date.parse(to),
    limit = Number(maxPoints);
  const ids = [...new Set(nodes.split(',').filter(Boolean))];
  if (
    !instant.test(from) ||
    !instant.test(to) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 30 * 86400000 ||
    !Number.isInteger(limit) ||
    limit < 60 ||
    limit > 600 ||
    ids.length > 100 ||
    ids.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
  )
    throw new BadRequestException('Выберите корректный период до 30 дней и не более 100 нод.');
  return {
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    start,
    end,
    ids,
    bucketSeconds: Math.max(60, Math.ceil((end - start) / 1000 / limit / 60) * 60),
  };
}
export type MetricHistoryRange = ReturnType<typeof parseMetricHistoryRange>;

@Injectable()
export class NodeMetricHistoryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly store: RemnawaveSettingsStore,
    private readonly remna: RemnawaveService,
  ) {}
  async get(range: MetricHistoryRange): Promise<NodeMetricHistory> {
    const [domain, status] = await Promise.all([this.store.domain(), this.remna.status()]);
    if (domain !== status.domain) throw new BadRequestException('Подключение изменилось. Обновите историю.');
    const selected = status.nodes.filter((n) => !range.ids.length || range.ids.includes(n.uuid));
    if (range.ids.some((id) => !selected.some((n) => n.uuid === id)))
      throw new BadRequestException('Выбранная нода отсутствует в текущем подключении.');
    if (selected.length > 100) throw new BadRequestException('Выберите не более 100 нод.');
    const result: NodeMetricHistory = {
      panel: domain,
      from: range.from,
      to: range.to,
      bucketSeconds: range.bucketSeconds,
      collectedSince: null,
      nodes: [],
      events: [],
      eventsTruncated: false,
      onlineSummary: { peak: null, peakAt: null, average: null, minimum: null, samples: 0, partial: false },
    };
    if (!domain || !selected.length) return result;
    const ids = sql.join(
      selected.map((n) => sql`${n.uuid}::uuid`),
      sql`, `,
    );
    const aggregates = sql.join(
      fields.flatMap((f) =>
        ['avg', 'min', 'max'].map(
          (op) => sql`${sql.raw(op)}((values->>${f})::float) AS ${sql.raw(`${f}_${op}`)}`,
        ),
      ),
      sql`, `,
    );
    const [first, samples, incidents, checks, online] = await Promise.all([
      this.db.execute(
        sql`SELECT min(sampled_at) AS first FROM remna_metric_samples WHERE panel=${domain} AND node_uuid IN (${ids})`,
      ),
      this.db.execute(sql`SELECT node_uuid AS uuid, bucket_t AS t, ${aggregates}
        FROM (SELECT node_uuid, values, ${range.start / 1000} + floor((extract(epoch FROM sampled_at)-${range.start / 1000})/${range.bucketSeconds})*${range.bucketSeconds} AS bucket_t
        FROM remna_metric_samples WHERE panel=${domain} AND node_uuid IN (${ids}) AND sampled_at >= ${range.from}::timestamptz AND sampled_at < ${range.to}::timestamptz) samples
        GROUP BY node_uuid,bucket_t ORDER BY bucket_t`),
      this.db.execute(sql`SELECT * FROM (
        SELECT id, node_uuid, server_name, title, detail, opened_at AS event_at, 'incident_opened' AS type FROM incidents WHERE node_uuid IN (${ids}) AND opened_at >= ${range.from}::timestamptz AND opened_at < ${range.to}::timestamptz
        UNION ALL SELECT id, node_uuid, server_name, title, detail, resolved_at AS event_at, 'incident_resolved' AS type FROM incidents WHERE node_uuid IN (${ids}) AND resolved_at >= ${range.from}::timestamptz AND resolved_at < ${range.to}::timestamptz
        ) events ORDER BY event_at LIMIT 1001`),
      this.db.execute(sql`SELECT key,value FROM app_meta WHERE (${sql.join(
        selected.map((n) => sql`key LIKE ${`checkhost.node.${n.uuid}.%`}`),
        sql` OR `,
      )})
        AND updated_at >= ${new Date(range.start - 86400000).toISOString()}::timestamptz AND updated_at < ${new Date(range.end + 86400000).toISOString()}::timestamptz ORDER BY updated_at LIMIT 1001`),
      // Sum simultaneous raw samples; never sum the independent maxima of different nodes.
      this.db.execute(sql`WITH snapshots AS (
        SELECT sampled_at, sum((values->>'online')::float) AS total,
          count(DISTINCT node_uuid) FILTER (WHERE values->>'online' IS NOT NULL) AS known
        FROM remna_metric_samples WHERE panel=${domain} AND node_uuid IN (${ids})
          AND sampled_at >= ${range.from}::timestamptz AND sampled_at < ${range.to}::timestamptz
        GROUP BY sampled_at
      ), complete AS (SELECT * FROM snapshots WHERE known=${selected.length})
      SELECT max(total) AS peak, min(total) AS minimum, avg(total) AS average, count(*) AS samples,
        (SELECT sampled_at FROM complete ORDER BY total DESC, sampled_at ASC LIMIT 1) AS peak_at,
        EXISTS(SELECT 1 FROM snapshots WHERE known<${selected.length}) AS partial FROM complete`),
    ]);
    const summary = online.rows[0];
    if (summary) {
      const number = (value: unknown) =>
        value == null || !Number.isFinite(Number(value)) ? null : Number(value);
      result.onlineSummary = {
        peak: number(summary.peak),
        minimum: number(summary.minimum),
        average: number(summary.average),
        samples: Number(summary.samples) || 0,
        peakAt: summary.peak_at ? new Date(String(summary.peak_at)).toISOString() : null,
        partial: summary.partial === true,
      };
    }
    result.collectedSince = first.rows[0]?.first ? new Date(String(first.rows[0].first)).toISOString() : null;
    const byNode = new Map<string, Map<number, NodeMetricHistory['nodes'][number]['points'][number]>>();
    for (const row of samples.rows) {
      const t = Number(row.t) * 1000;
      if (!Number.isFinite(t) || t < range.start || t >= range.end) continue;
      const point = {
        t,
        ...empty(),
        min: empty(),
        max: empty(),
      } as NodeMetricHistory['nodes'][number]['points'][number];
      for (const f of fields)
        for (const op of ['avg', 'min', 'max'] as const) {
          const raw = row[`${f}_${op}`],
            value = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
          if (op === 'avg') point[f] = value;
          else point[op][f] = value;
        }
      const uuid = String(row.uuid);
      if (!byNode.has(uuid)) byNode.set(uuid, new Map());
      byNode.get(uuid)?.set(t, point);
    }
    result.nodes = selected.map((n) => {
      const points: NodeMetricHistory['nodes'][number]['points'] = [];
      for (let t = range.start; t < range.end; t += range.bucketSeconds * 1000)
        points.push(byNode.get(n.uuid)?.get(t) ?? { t, ...empty(), min: empty(), max: empty() });
      return { uuid: n.uuid, name: n.name, address: n.address, points };
    });
    for (const row of incidents.rows) {
      const t = new Date(String(row.event_at)).getTime();
      result.events.push({
        id: `${row.id}:${row.type}`,
        t,
        nodeUuid: String(row.node_uuid),
        nodeName: String(row.server_name),
        type: row.type as 'incident_opened' | 'incident_resolved',
        title: String(row.title),
        summary: String(row.detail).slice(0, 2000),
        link: null,
      });
    }
    for (const row of checks.rows)
      try {
        const entry = JSON.parse(String(row.value)),
          report = tcpCheckReportSchema.parse(entry.report);
        const t = Date.parse(report.checkedAt),
          node = selected.find((n) => String(row.key).startsWith(`checkhost.node.${n.uuid}.`));
        if (!node || !Number.isFinite(t) || t < range.start || t >= range.end) continue;
        const verdict = {
          reachable: 'Доступен',
          russia_unreachable: 'Недоступен из РФ',
          port_unreachable: 'Порт не отвечает',
          unknown: 'Неполный результат',
        }[report.verdict];
        result.events.push({
          id: `tcp:${entry.id}`,
          t,
          nodeUuid: node.uuid,
          nodeName: node.name,
          type: 'tcp_check',
          title: 'TCP-проверка · Check-Host',
          summary: `${report.target} · ${verdict}`,
          link: report.link,
        });
      } catch {
        /* Older malformed records must not break the complete metric history. */
      }
    result.events.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id));
    result.eventsTruncated =
      incidents.rows.length > 1000 || checks.rows.length > 1000 || result.events.length > 1000;
    result.events = result.events.slice(0, 1000);
    if ((await this.store.domain()) !== domain)
      throw new BadRequestException('Подключение изменилось. Обновите историю.');
    return result;
  }
}
