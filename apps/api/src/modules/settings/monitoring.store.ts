import { Inject, Injectable } from '@nestjs/common';
import { MONITORING_DEFAULTS, monitoringSettingsSchema, type MonitoringSettings } from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
@Injectable()
export class MonitoringStore {
  constructor(@Inject(DB) private readonly db: Db) {}
  async get(): Promise<MonitoringSettings> {
    const row = await this.db.query.appMeta.findFirst({where: eq(appMeta.key, 'settings.monitoring')});
    let stored: unknown = {};
    try { stored = row ? JSON.parse(row.value) : {}; } catch { stored = {}; }
    const parsed = monitoringSettingsSchema.safeParse({...MONITORING_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {})});
    return parsed.success ? parsed.data : {...MONITORING_DEFAULTS};
  }
  async set(patch: { [K in keyof MonitoringSettings]?: MonitoringSettings[K] | undefined }) {
    const before = await this.get();
    const after = monitoringSettingsSchema.parse({...before, ...Object.fromEntries(Object.entries(patch).filter(([,v])=>v!==undefined))});
    await this.db.insert(appMeta).values({key:'settings.monitoring',value:JSON.stringify(after)})
      .onConflictDoUpdate({target:appMeta.key,set:{value:JSON.stringify(after),updatedAt:new Date()}});
    return after;
  }
}
