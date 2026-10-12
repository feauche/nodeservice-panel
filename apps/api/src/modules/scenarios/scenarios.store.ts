import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { type Scenario, scenariosSchema } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
@Injectable()
export class ScenariosStore {
  constructor(@Inject(DB) private db: Db) {}
  scope(panel: string) {
    return createHash('sha256').update(panel).digest('hex');
  }
  async read<T>(key: string): Promise<T | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  }
  async write(key: string, value: unknown) {
    await this.db
      .insert(appMeta)
      .values({ key, value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      });
  }
  async list(panel: string | null): Promise<Scenario[]> {
    if (!panel) return [];
    const raw = await this.read('scenarios.rules.' + this.scope(panel));
    const parsed = scenariosSchema.safeParse(raw ?? { items: [] });
    return parsed.success ? parsed.data.items : [];
  }
  async set(panel: string, items: Scenario[]) {
    const parsed = scenariosSchema.parse({ items });
    if (new Set(parsed.items.map((i) => i.id)).size !== parsed.items.length)
      throw new Error('Повторяющийся идентификатор сценария.');
    await this.write('scenarios.rules.' + this.scope(panel), parsed);
    return parsed;
  }
}
