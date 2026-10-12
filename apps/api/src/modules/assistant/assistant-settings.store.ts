import { Inject, Injectable } from '@nestjs/common';
import {
  ASSISTANT_LEVEL_DEFAULT,
  ASSISTANT_LEVELS,
  ASSISTANT_PROVIDERS,
  type AssistantLevel,
  type AssistantProvider,
  type AssistantSettingsUpdate,
  type AssistantStatus,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';

const KEY = 'settings.assistant';
const DEFAULT_PROVIDER: AssistantProvider = 'zveno';

interface Stored {
  apiKeyEnc?: string | undefined;
  provider: AssistantProvider;
  model: string;
  level: AssistantLevel;
}

/** Ключ LLM хранится шифрованным (как TOTP-секрет), в app_meta — попадает в бэкап. */
@Injectable()
export class AssistantSettingsStore {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  private async load(): Promise<Stored> {
    const base: Stored = {
      provider: DEFAULT_PROVIDER,
      model: '',
      level: ASSISTANT_LEVEL_DEFAULT,
    };
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (!row) return base;
    try {
      const p = JSON.parse(row.value) as Partial<Stored>;
      const provider = ASSISTANT_PROVIDERS.includes(p.provider as AssistantProvider)
        ? (p.provider as AssistantProvider)
        : DEFAULT_PROVIDER;
      const level = ASSISTANT_LEVELS.includes(p.level as AssistantLevel)
        ? (p.level as AssistantLevel)
        : ASSISTANT_LEVEL_DEFAULT;
      return {
        apiKeyEnc: p.apiKeyEnc,
        provider,
        model: typeof p.model === 'string' ? p.model : '',
        level,
      };
    } catch {
      return base;
    }
  }

  private async save(value: Stored): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value: serialized })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: serialized, updatedAt: new Date() } });
  }

  async status(): Promise<AssistantStatus> {
    const s = await this.load();
    // Ассистент работает, только когда есть и ключ, и название модели.
    return {
      enabled: Boolean(s.apiKeyEnc) && s.model.trim().length > 0,
      provider: s.provider,
      model: s.model,
      level: s.level,
    };
  }

  async config(): Promise<{
    apiKey: string;
    provider: AssistantProvider;
    model: string;
    level: AssistantLevel;
  } | null> {
    const s = await this.load();
    if (!s.apiKeyEnc || !s.model.trim()) return null;
    try {
      return {
        apiKey: this.crypto.decrypt(s.apiKeyEnc),
        provider: s.provider,
        model: s.model,
        level: s.level,
      };
    } catch {
      return null;
    }
  }

  async set(patch: AssistantSettingsUpdate): Promise<void> {
    const current = await this.load();
    const next: Stored = {
      provider: patch.provider ?? current.provider,
      model: patch.model !== undefined ? patch.model : current.model,
      apiKeyEnc: current.apiKeyEnc,
      level: patch.level ?? current.level,
    };
    if (patch.clearKey) next.apiKeyEnc = undefined;
    else if (patch.apiKey) next.apiKeyEnc = this.crypto.encrypt(patch.apiKey);
    await this.save(next);
  }
}
