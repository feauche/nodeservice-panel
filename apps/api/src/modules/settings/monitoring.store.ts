import { Inject, Injectable } from '@nestjs/common';
import {
  MONITORING_DEFAULTS,
  MONITORING_DEFAULTS_BEFORE_0_94,
  type MonitoringSettings,
  monitoringSettingsSchema,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

/**
 * Старые «Автопроверки» (до 0.85) — только для переноса при обновлении: выключенный мониторинг остаётся
 * выключенным, испорченная запись его не включает. Поля и границы — как в той версии.
 */
const legacyInterval = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const legacyAutochecksSchema = z.object({
  sshEnabled: z.boolean().default(true),
  sshIntervalMinutes: legacyInterval(5, 1440).default(15),
  sshAgentEnabled: z.boolean().default(true),
  sshAgentIntervalMinutes: legacyInterval(15, 10_080).default(60),
  agentOfflineEnabled: z.boolean().default(true),
  agentOfflineAfterSeconds: legacyInterval(30, 600).default(30),
  metricsEnabled: z.boolean().default(true),
  metricsIntervalSeconds: legacyInterval(5, 120).default(10),
  serverChecksEnabled: z.boolean().default(true),
});

/** Версия записи настроек: с 0.94.0 (быстрые значения по умолчанию) — 2; у прежних записей её нет. */
const VERSION_KEY = '_v';
const SETTINGS_VERSION = 2;

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
            const parsed = legacyAutochecksSchema.safeParse(value);
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
    if (row && stored && typeof stored === 'object' && !Array.isArray(stored))
      stored = await this.fastDefaults(stored as Record<string, unknown>);
    if (row && (!stored || typeof stored !== 'object' || Array.isArray(stored)))
      return { ...MONITORING_DEFAULTS, enabled: false };
    const parsed = monitoringSettingsSchema.safeParse({
      ...MONITORING_DEFAULTS,
      ...(stored && typeof stored === 'object' ? stored : {}),
    });
    return parsed.success ? parsed.data : { ...MONITORING_DEFAULTS, enabled: false };
  }
  /**
   * Один раз при обновлении до 0.94.0: значения, равные прежним «по умолчанию» (опрос раз в минуту, три
   * подтверждения…), переходят на новые быстрые, а прежний порог процента процессора уходит. Изменённое владельцем
   * вручную не трогаем. Записи с отметкой версии (сохранённые уже в 0.94.0 и позже) не переносятся: значение,
   * выбранное позже вручную, даже совпавшее с прежним «по умолчанию», остаётся.
   */
  private async fastDefaults(stored: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (stored[VERSION_KEY] === SETTINGS_VERSION) return stored;
    const next: Record<string, unknown> = { ...stored };
    let changed = false;
    for (const [key, old] of Object.entries(MONITORING_DEFAULTS_BEFORE_0_94))
      if (next[key] === old) {
        next[key] = MONITORING_DEFAULTS[key as keyof MonitoringSettings];
        changed = true;
      }
    if ('cpuPercent' in next) {
      delete next.cpuPercent;
      changed = true;
    }
    if (!changed) return stored;
    next[VERSION_KEY] = SETTINGS_VERSION;
    await this.db
      .insert(appMeta)
      .values({ key: 'settings.monitoring', value: JSON.stringify(next) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(next), updatedAt: new Date() },
      });
    return next;
  }
  async set(patch: { [K in keyof MonitoringSettings]?: MonitoringSettings[K] | undefined }) {
    const before = await this.get();
    const after = monitoringSettingsSchema.parse({
      ...before,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    });
    const value = JSON.stringify({ ...after, [VERSION_KEY]: SETTINGS_VERSION });
    await this.db
      .insert(appMeta)
      .values({ key: 'settings.monitoring', value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
    return after;
  }
}
