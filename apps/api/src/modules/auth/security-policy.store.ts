import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  SECURITY_POLICY_DEFAULTS,
  type SecurityPolicy,
  type SecurityPolicyUpdate,
  securityPolicySchema,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

const KEY = 'settings.security';
/** Политику читает каждый запрос (TTL сессии) — держим в памяти, обновляем раз в 5 с и при записи. */
const CACHE_MS = 5_000;

/**
 * Политика безопасности (idle-таймаут сессии, автоблокировка, «всегда спрашивать 2FA»).
 * Хранится в app_meta, как и остальные настройки, — попадает в бэкап БД.
 * Живёт в auth-core, потому что нужна SessionStore и AuthService, а не только странице настроек.
 */
@Injectable()
export class SecurityPolicyStore {
  private readonly log = new Logger(SecurityPolicyStore.name);
  private cache: { value: SecurityPolicy; at: number } | null = null;

  constructor(@Inject(DB) private readonly db: Db) {}

  async get(): Promise<SecurityPolicy> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    const value = await this.load();
    this.cache = { value, at: Date.now() };
    return value;
  }

  async set(patch: SecurityPolicyUpdate): Promise<{ before: SecurityPolicy; after: SecurityPolicy }> {
    const before = await this.load();
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const after = securityPolicySchema.parse({ ...before, ...defined });
    const serialized = JSON.stringify(after);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value: serialized })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: serialized, updatedAt: new Date() } });
    this.cache = { value: after, at: Date.now() };
    return { before, after };
  }

  private async load(): Promise<SecurityPolicy> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (!row) return SECURITY_POLICY_DEFAULTS;
    try {
      const parsed = securityPolicySchema.safeParse(JSON.parse(row.value));
      if (parsed.success) return parsed.data;
    } catch {
      /* ниже */
    }
    this.log.warn('Политика безопасности повреждена — использую значения по умолчанию');
    return SECURITY_POLICY_DEFAULTS;
  }
}
