import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  AUTOCHECKS_DEFAULTS,
  type AutochecksSettings,
  type AutochecksSettingsUpdate,
  autochecksSettingsSchema,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

const KEY = 'settings.autochecks';
/** Настройки читают фоновые джобы каждый тик — держим в памяти, обновляем раз в 5 с и при записи. */
const CACHE_MS = 5_000;

/**
 * Настройки → «Автопроверки»: интервалы и тумблеры фоновых проверок.
 * Хранятся в app_meta (попадают в бэкап), формат — packages/shared/src/autochecks.ts.
 */
@Injectable()
export class AutochecksStore {
  private readonly log = new Logger(AutochecksStore.name);
  private cache: { value: AutochecksSettings; at: number } | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async get(): Promise<AutochecksSettings> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const value = await this.load();
    this.cache = { value, at: Date.now() };
    return value;
  }

  async set(
    patch: AutochecksSettingsUpdate,
  ): Promise<{ before: AutochecksSettings; after: AutochecksSettings }> {
    const before = await this.load();
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const after = autochecksSettingsSchema.parse({ ...before, ...defined });
    const serialized = JSON.stringify(after);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value: serialized })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: serialized, updatedAt: new Date() } });
    this.cache = { value: after, at: Date.now() };
    return { before, after };
  }

  private async load(): Promise<AutochecksSettings> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (!row) return AUTOCHECKS_DEFAULTS;
    try {
      return autochecksSettingsSchema.parse(JSON.parse(row.value));
    } catch {
      this.log.warn('Настройки «Автопроверки» повреждены, использую значения по умолчанию');
      return AUTOCHECKS_DEFAULTS;
    }
  }
}
