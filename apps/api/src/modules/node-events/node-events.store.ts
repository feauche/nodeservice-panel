import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type NodeMetricHistory, nodeMetricHistorySchema } from '@nodeservice/shared';
import { sql } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';

type Event = NodeMetricHistory['events'][number];
const eventSchema = nodeMetricHistorySchema.shape.events.element;
@Injectable()
export class NodeEventsStore {
  constructor(@Inject(DB) private readonly db: Db) {}
  private prefix(panel: string) {
    return 'node.events.' + createHash('sha256').update(panel).digest('hex') + '.';
  }
  async append(panel: string, event: Event) {
    const parsed = eventSchema.parse(event);
    const key = this.prefix(panel) + createHash('sha256').update(parsed.id).digest('hex');
    // Retry/polling the same result is idempotent. No credentials or VPN keys are stored here.
    await this.db.execute(
      sql`INSERT INTO app_meta(key,value) VALUES(${key},${JSON.stringify(parsed)}) ON CONFLICT(key) DO NOTHING`,
    );
  }
  async list(panel: string, ids: string[], from: number, to: number) {
    const rows =
      await this.db.execute(sql`SELECT value FROM app_meta WHERE key LIKE ${this.prefix(panel) + '%'}
      AND (value::jsonb->>'nodeUuid') IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
      AND (value::jsonb->>'t')::numeric >= ${from} AND (value::jsonb->>'t')::numeric < ${to}
      ORDER BY (value::jsonb->>'t')::numeric, key LIMIT 1001`);
    const events: Event[] = [];
    for (const row of rows.rows) {
      try {
        events.push(eventSchema.parse(JSON.parse(String(row.value))));
      } catch {
        /* Keep valid history readable. */
      }
    }
    return { events: events.slice(0, 1000), truncated: rows.rows.length > 1000 };
  }
}
