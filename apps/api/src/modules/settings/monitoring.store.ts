import { Inject, Injectable } from '@nestjs/common';
import {
  MONITORING_DEFAULTS,
  MONITORING_DEFAULTS_BEFORE_0_94,
  MONITORING_DEFAULTS_BEFORE_0_95,
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

/**
 * Версия записи настроек: 2 — 0.94.0 (быстрые значения по умолчанию), 3 — 0.95.0 (в записи только отличия от
 * значений по умолчанию); у записей до 0.94.0 её нет.
 */
const VERSION_KEY = '_v';
const SETTINGS_VERSION = 3;
/**
 * Прежние значения по умолчанию: у записи версии ниже `before` такое значение считается нетронутым и переходит
 * на нынешнее. Записи версии `before` и новее — уже сохранённые после смены, их значения выбраны вручную.
 */
const OLD_DEFAULTS: { before: number; values: Partial<MonitoringSettings> }[] = [
  { before: 2, values: MONITORING_DEFAULTS_BEFORE_0_94 },
  { before: 3, values: MONITORING_DEFAULTS_BEFORE_0_95 },
];
/** Только отличия от значений по умолчанию: остальное следует за ними и после будущих обновлений. */
function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([key, value]) =>
        key in MONITORING_DEFAULTS && value !== MONITORING_DEFAULTS[key as keyof MonitoringSettings],
    ),
  );
}

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
        const initial = { ...compact({ ...MONITORING_DEFAULTS, enabled }), [VERSION_KEY]: SETTINGS_VERSION };
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
      stored = await this.upgrade(stored as Record<string, unknown>);
    if (row && (!stored || typeof stored !== 'object' || Array.isArray(stored)))
      return { ...MONITORING_DEFAULTS, enabled: false };
    const parsed = monitoringSettingsSchema.safeParse({
      ...MONITORING_DEFAULTS,
      ...(stored && typeof stored === 'object' ? stored : {}),
    });
    return parsed.success ? parsed.data : { ...MONITORING_DEFAULTS, enabled: false };
  }
  /**
   * Один раз при обновлении: значения, равные прежним «по умолчанию» своей версии (опрос раз в минуту, три
   * подтверждения, 5 минут превышения…), переходят на нынешние; изменённое владельцем вручную не трогаем. Запись
   * сжимается до отличий от значений по умолчанию — иначе после любого сохранения новые значения по умолчанию
   * больше не доходили бы (так было до 0.95.0).
   */
  private async upgrade(stored: Record<string, unknown>): Promise<Record<string, unknown>> {
    const version = typeof stored[VERSION_KEY] === 'number' ? (stored[VERSION_KEY] as number) : 1;
    if (version >= SETTINGS_VERSION) return stored;
    const next: Record<string, unknown> = { ...stored };
    for (const step of OLD_DEFAULTS)
      if (version < step.before)
        for (const [key, old] of Object.entries(step.values)) if (next[key] === old) delete next[key];
    const value = { ...compact(next), [VERSION_KEY]: SETTINGS_VERSION };
    await this.db
      .insert(appMeta)
      .values({ key: 'settings.monitoring', value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(value), updatedAt: new Date() },
      });
    return value;
  }
  async set(patch: { [K in keyof MonitoringSettings]?: MonitoringSettings[K] | undefined }) {
    const before = await this.get();
    const after = monitoringSettingsSchema.parse({
      ...before,
      ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    });
    const value = JSON.stringify({ ...compact(after), [VERSION_KEY]: SETTINGS_VERSION });
    await this.db
      .insert(appMeta)
      .values({ key: 'settings.monitoring', value })
      .onConflictDoUpdate({ target: appMeta.key, set: { value, updatedAt: new Date() } });
    return after;
  }
}
