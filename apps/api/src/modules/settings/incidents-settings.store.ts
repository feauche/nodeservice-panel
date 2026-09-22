import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  INCIDENTS_SETTINGS_DEFAULTS,
  type IncidentsSettings,
  type IncidentsSettingsUpdate,
  incidentsSettingsSchema,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

const KEY = 'settings.incidents';
const CACHE_MS = 5_000;

/** Настройки инцидентов (пороги, время реакции, автопочинка). Хранятся в app_meta. */
@Injectable()
export class IncidentsSettingsStore {
  private readonly log = new Logger(IncidentsSettingsStore.name);
  private cache: { value: IncidentsSettings; at: number } | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async get(): Promise<IncidentsSettings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const value = await this.load();
    this.cache = { value, at: Date.now() };
    return value;
  }

  async set(
    patch: IncidentsSettingsUpdate,
  ): Promise<{ before: IncidentsSettings; after: IncidentsSettings }> {
    const before = await this.load();
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const after = incidentsSettingsSchema.parse({ ...before, ...defined });
    const serialized = JSON.stringify(after);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value: serialized })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: serialized, updatedAt: new Date() } });
    this.cache = { value: after, at: Date.now() };
    return { before, after };
  }

  private async load(): Promise<IncidentsSettings> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (!row) return INCIDENTS_SETTINGS_DEFAULTS;
    try {
      return incidentsSettingsSchema.parse(JSON.parse(row.value));
    } catch {
      this.log.warn('Настройки инцидентов повреждены, использую значения по умолчанию');
      return INCIDENTS_SETTINGS_DEFAULTS;
    }
  }
}
