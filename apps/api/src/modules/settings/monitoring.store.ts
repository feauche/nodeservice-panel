import { Inject, Injectable } from '@nestjs/common';
import {
  AUTOCHECKS_DEFAULTS,
  autochecksSettingsSchema,
  MONITORING_DEFAULTS,
  type MonitoringSettings,
  monitoringSettingsSchema,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
@Injectable()
export class MonitoringStore {
  constructor(@Inject(DB) private readonly db: Db) {}
  async get(): Promise<MonitoringSettings> {
    let row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, 'settings.monitoring') });
    if (!row) {
      const legacy = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, 'settings.autochecks') });
      if (legacy) {
        let enabled = false;
        try {
          const value: unknown = JSON.parse(legacy.value);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            const parsed = autochecksSettingsSchema.safeParse({ ...AUTOCHECKS_DEFAULTS, ...value });
            const globalEnabled = 'enabled' in value ? value.enabled : undefined;
            enabled =
              parsed.success &&
              parsed.data.metricsEnabled &&
              (globalEnabled === undefined || globalEnabled === true);
          }
        } catch {
          /* Damaged legacy settings must not silently enable new monitoring. */
        }
        const initial = { ...MONITORING_DEFAULTS, enabled };
        // A concurrent explicit save always wins over this one-time migration.
        await this.db
          .insert(appMeta)
          .values({ key: 'settings.monitoring', value: JSON.stringify(initial) })
          .onConflictDoNothing({ target: appMeta.key });
        row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, 'settings.monitoring') });
      }
    }
    let stored: unknown = {};
    try {
      stored = row ? JSON.parse(row.value) : {};
    } catch {
      return { ...MONITORING_DEFAULTS, enabled: false };
    }
    if (row && (!stored || typeof stored !== 'object' || Array.isArray(stored)))
      return { ...MONITORING_DEFAULTS, enabled: false };
    const parsed = monitoringSettingsSchema.safeParse({
      ...MONITORING_DEFAULTS,
      ...(stored && typeof stored === 'object' ? stored : {}),
    });
    return parsed.success ? parsed.data : { ...MONITORING_DEFAULTS, enabled: false };
  }
  async set(patch: { [K in keyof MonitoringSettings]?: MonitoringSettings[K] | undefined }) {
    const before = await this.get();
    const after = monitoringSettingsSchema.parse({
      ...before,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    });
    await this.db
      .insert(appMeta)
      .values({ key: 'settings.monitoring', value: JSON.stringify(after) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(after), updatedAt: new Date() },
      });
    return after;
  }
}
