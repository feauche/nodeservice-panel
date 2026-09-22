import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AssistantSettingsUpdate,
  AssistantStatus,
  AutochecksSettings,
  AutochecksSettingsUpdate,
  IncidentsSettings,
  IncidentsSettingsUpdate,
} from '@nodeservice/shared';
import {
  APPEARANCE_DEFAULTS,
  type AppearanceSettings,
  type AppearanceSettingsUpdate,
  appearanceSettingsSchema,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { AssistantSettingsStore } from '../assistant/assistant-settings.store.js';
import { diffChanges } from '../audit/audit.diff.js';
import { AuditService } from '../audit/audit.service.js';
import { AutochecksStore } from './autochecks.store.js';
import { IncidentsSettingsStore } from './incidents-settings.store.js';

/**
 * Настройки панели хранятся в app_meta как JSON по ключу раздела.
 * Пока один раздел — «внешний вид»; следующие этапы добавят свои ключи.
 */
const KEY_APPEARANCE = 'settings.appearance';

@Injectable()
export class SettingsService {
  private readonly log = new Logger(SettingsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly autochecks: AutochecksStore,
    private readonly incidents: IncidentsSettingsStore,
    private readonly assistant: AssistantSettingsStore,
  ) {}

  getAssistant(): Promise<AssistantStatus> {
    return this.assistant.status();
  }

  async updateAssistant(patch: AssistantSettingsUpdate): Promise<AssistantStatus> {
    await this.assistant.set(patch);
    const after = await this.assistant.status();
    this.audit.extend({ metadata: { enabled: after.enabled, model: after.model } });
    return after;
  }

  getIncidents(): Promise<IncidentsSettings> {
    return this.incidents.get();
  }

  async updateIncidents(patch: IncidentsSettingsUpdate): Promise<IncidentsSettings> {
    const { before, after } = await this.incidents.set(patch);
    this.audit.extend({ changes: diffChanges(before, after) });
    return after;
  }

  getAutochecks(): Promise<AutochecksSettings> {
    return this.autochecks.get();
  }

  async updateAutochecks(patch: AutochecksSettingsUpdate): Promise<AutochecksSettings> {
    const { before, after } = await this.autochecks.set(patch);
    this.audit.extend({ changes: diffChanges(before, after) });
    return after;
  }

  async getAppearance(): Promise<AppearanceSettings> {
    const raw = await this.readJson(KEY_APPEARANCE);
    const parsed = appearanceSettingsSchema.safeParse(raw ?? APPEARANCE_DEFAULTS);
    if (!parsed.success) {
      // Повреждённая запись не должна ронять экран входа — отдаём значения по умолчанию.
      this.log.warn(`Настройки «внешний вид» повреждены, использую значения по умолчанию`);
      return APPEARANCE_DEFAULTS;
    }
    return parsed.data;
  }

  async updateAppearance(patch: AppearanceSettingsUpdate): Promise<AppearanceSettings> {
    const current = await this.getAppearance();
    // undefined = «поле не трогать» (partial), null = «сбросить»
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const next = appearanceSettingsSchema.parse({ ...current, ...defined });
    await this.writeJson(KEY_APPEARANCE, next);
    // В Журнал (запись делает @Audit на контроллере) — только изменённые поля.
    this.audit.extend({ changes: diffChanges(current, next) });
    return next;
  }

  private async readJson(key: string): Promise<unknown> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  }

  private async writeJson(key: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.db
      .insert(appMeta)
      .values({ key, value: serialized })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: serialized, updatedAt: new Date() } });
  }
}
