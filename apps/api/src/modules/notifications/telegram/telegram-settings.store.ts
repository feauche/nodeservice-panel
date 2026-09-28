import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  INCIDENT_KINDS,
  maskTelegramProxy,
  maskTelegramUrl,
  TELEGRAM_DELIVERY_DEFAULT,
  TELEGRAM_EVENTS,
  TELEGRAM_EVENTS_DEFAULT,
  TELEGRAM_KINDS_DEFAULT,
  TELEGRAM_QUIET_DEFAULT,
  type TelegramDelivery,
  type TelegramDestination,
  type TelegramEvents,
  type TelegramKinds,
  type TelegramQuiet,
  type TelegramSettings,
  type TelegramTestResult,
  telegramDeliverySchema,
  telegramQuietSchema,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { CryptoService } from '../../../common/crypto/crypto.service.js';
import { DB, type Db } from '../../../infra/db/db.module.js';
import { appMeta } from '../../../infra/db/schema/index.js';

const KEY = 'settings.telegram';
const DIGEST_KEY = 'telegram.digest';

export interface StoredDestination {
  id: string;
  tokenEnc: string;
  chatId: string;
  topic: number | null;
  botName: string | null;
  chatTitle: string | null;
  lastTest: TelegramTestResult | null;
}
interface Stored {
  destinations: StoredDestination[];
  events: TelegramEvents;
  quiet: TelegramQuiet;
  kinds: TelegramKinds;
  delivery: TelegramDelivery;
  /** Прокси целиком (с паролем) — зашифрован. */
  proxyEnc?: string | null;
}
export interface DigestItem {
  event: string;
  title: string;
  at: string;
}

/** Назначение с расшифрованным токеном — только внутри сервера, наружу не отдаётся. */
export interface LiveDestination extends Omit<StoredDestination, 'tokenEnc'> {
  token: string;
  /** Через какой прокси слать (общий для всех чатов); null — напрямую. */
  proxy?: string | null;
}

/** Настройки Telegram в app_meta; токены ботов шифруются (как ключ Джарвиса) и наружу не отдаются. */
@Injectable()
export class TelegramSettingsStore {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly crypto: CryptoService,
  ) {}

  private async read<T>(key: string): Promise<T | null> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, key) });
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  private async write(key: string, value: unknown): Promise<void> {
    const v = JSON.stringify(value);
    await this.db
      .insert(appMeta)
      .values({ key, value: v })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: v, updatedAt: new Date() } });
  }

  async load(): Promise<Stored> {
    const p = (await this.read<Partial<Stored>>(KEY)) ?? {};
    const events = { ...TELEGRAM_EVENTS_DEFAULT };
    if (p.events && typeof p.events === 'object')
      for (const k of TELEGRAM_EVENTS) if (typeof p.events[k] === 'boolean') events[k] = p.events[k];
    const quiet = telegramQuietSchema.safeParse(p.quiet);
    const kinds = { ...TELEGRAM_KINDS_DEFAULT };
    if (p.kinds && typeof p.kinds === 'object')
      for (const k of INCIDENT_KINDS) if (typeof p.kinds[k] === 'boolean') kinds[k] = p.kinds[k];
    const delivery = telegramDeliverySchema.safeParse(p.delivery);
    return {
      destinations: Array.isArray(p.destinations) ? p.destinations : [],
      events,
      quiet: quiet.success ? quiet.data : { ...TELEGRAM_QUIET_DEFAULT },
      kinds,
      delivery: delivery.success ? delivery.data : { ...TELEGRAM_DELIVERY_DEFAULT },
      proxyEnc: typeof p.proxyEnc === 'string' ? p.proxyEnc : null,
    };
  }

  save(value: Stored): Promise<void> {
    return this.write(KEY, value);
  }

  toPublic(s: Stored): TelegramSettings {
    return {
      destinations: s.destinations.map(
        (d): TelegramDestination => ({
          id: d.id,
          masked: maskTelegramUrl(d.chatId, d.topic),
          chatId: d.chatId,
          topic: d.topic,
          botName: d.botName,
          chatTitle: d.chatTitle,
          lastTest: d.lastTest,
        }),
      ),
      events: s.events,
      quiet: s.quiet,
      kinds: s.kinds,
      delivery: s.delivery,
      proxy: (() => {
        const p = this.proxy(s);
        return p ? maskTelegramProxy(p) : null;
      })(),
    };
  }

  /** Прокси целиком для отправки; null — напрямую (или не расшифровался). */
  proxy(s: Stored): string | null {
    if (!s.proxyEnc) return null;
    try {
      return this.crypto.decrypt(s.proxyEnc);
    } catch {
      return null;
    }
  }

  encryptProxy(url: string): string {
    return this.crypto.encrypt(url);
  }

  newDestination(token: string, chatId: string, topic: number | null): StoredDestination {
    return {
      id: randomUUID(),
      tokenEnc: this.crypto.encrypt(token),
      chatId,
      topic,
      botName: null,
      chatTitle: null,
      lastTest: null,
    };
  }

  /** Назначения с токенами; битые (не расшифровались) пропускаются. */
  live(s: Stored): LiveDestination[] {
    const out: LiveDestination[] = [];
    const proxy = this.proxy(s);
    for (const { tokenEnc, ...d } of s.destinations) {
      try {
        out.push({ ...d, token: this.crypto.decrypt(tokenEnc), proxy });
      } catch {
        /* ключ шифрования сменился — назначение надо добавить заново */
      }
    }
    return out;
  }

  async digest(): Promise<DigestItem[]> {
    return (await this.read<DigestItem[]>(DIGEST_KEY)) ?? [];
  }

  async setDigest(items: DigestItem[]): Promise<void> {
    await this.write(DIGEST_KEY, items.slice(-50));
  }
}
