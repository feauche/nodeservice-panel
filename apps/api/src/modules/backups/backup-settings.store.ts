import { Inject, Injectable } from '@nestjs/common';
import {
  BACKUP_SETTINGS_DEFAULT,
  type BackupSettings,
  backupSettingsSchema,
  maskTelegramUrl,
  parseTelegramUrl,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

const KEY = 'settings.backups';
const SCHEDULE_KEY = 'backups.schedule';

/**
 * Ход расписания — рядом с настройками, но отдельной записью: её пишет фоновая задача, а не владелец.
 * В базе, а не в памяти: неудачная копия файла не оставляет, и после перезапуска панель иначе начала бы
 * отсчёт заново.
 */
export interface BackupScheduleState {
  /** Когда панель последний раз бралась за копию по расписанию — получилась она или нет. */
  attemptAt: string | null;
  /** Момент расписания, о сбое которого уже сообщили: одно сообщение на момент. */
  noticeSlot: string | null;
}

/** Как настройки лежат в app_meta: пароль и свой чат (с токеном бота) — зашифрованы. */
export interface StoredBackupSettings extends Omit<BackupSettings, 'passwordSet' | 'telegram'> {
  telegram: Omit<BackupSettings['telegram'], 'ownUrl'> & { ownUrlEnc: string | null };
  passwordEnc: string | null;
}

@Injectable()
export class BackupSettingsStore {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  async load(): Promise<StoredBackupSettings> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    const d = BACKUP_SETTINGS_DEFAULT;
    const fallback: StoredBackupSettings = {
      ...d,
      telegram: { ...d.telegram, ownUrlEnc: null },
      passwordEnc: null,
    };
    if (!row) return fallback;
    try {
      const raw = JSON.parse(row.value) as Partial<StoredBackupSettings>;
      const pub = backupSettingsSchema.safeParse({
        ...d,
        ...raw,
        telegram: { ...d.telegram, ...(raw.telegram ?? {}), ownUrl: null },
        extra: { ...d.extra, ...(raw.extra ?? {}) },
        passwordSet: false,
      });
      if (!pub.success) return fallback;
      const { passwordSet: _p, ...rest } = pub.data;
      return {
        ...rest,
        telegram: { ...rest.telegram, ownUrlEnc: raw.telegram?.ownUrlEnc ?? null },
        passwordEnc: raw.passwordEnc ?? null,
      };
    } catch {
      return fallback;
    }
  }

  async save(s: StoredBackupSettings): Promise<void> {
    const v = JSON.stringify(s);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value: v })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: v, updatedAt: new Date() } });
  }

  async schedule(): Promise<BackupScheduleState> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, SCHEDULE_KEY) });
    const iso = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null);
    try {
      const raw = (row ? JSON.parse(row.value) : {}) as Partial<BackupScheduleState> | null;
      return { attemptAt: iso(raw?.attemptAt), noticeSlot: iso(raw?.noticeSlot) };
    } catch {
      return { attemptAt: null, noticeSlot: null };
    }
  }

  async saveSchedule(s: BackupScheduleState): Promise<void> {
    const v = JSON.stringify(s);
    await this.db
      .insert(appMeta)
      .values({ key: SCHEDULE_KEY, value: v })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: v, updatedAt: new Date() } });
  }

  password(s: StoredBackupSettings): string | null {
    if (!s.passwordEnc) return null;
    try {
      return this.crypto.decrypt(s.passwordEnc);
    } catch {
      return null;
    }
  }

  ownUrl(s: StoredBackupSettings): string | null {
    if (!s.telegram.ownUrlEnc) return null;
    try {
      return this.crypto.decrypt(s.telegram.ownUrlEnc);
    } catch {
      return null;
    }
  }

  encrypt(v: string): string {
    return this.crypto.encrypt(v);
  }

  /** Наружу: без пароля, свой чат — маской. */
  toPublic(s: StoredBackupSettings): BackupSettings {
    const url = this.ownUrl(s);
    const t = url ? parseTelegramUrl(url) : null;
    const { passwordEnc, telegram, ...rest } = s;
    return {
      ...rest,
      telegram: {
        enabled: telegram.enabled,
        target: telegram.target,
        destinationId: telegram.destinationId,
        notifyFailure: telegram.notifyFailure,
        ownUrl: t ? maskTelegramUrl(t.chatId, t.topic) : null,
      },
      passwordSet: passwordEnc !== null,
    };
  }
}
