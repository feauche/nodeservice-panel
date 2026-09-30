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
const DELIVERY_KEY = 'telegram.delivery';

/** Столько неудачных отправок в чат подряд — и владельцу пора сказать, что сообщения не доходят. */
const DELIVERY_FAILS_TO_WARN = 3;
/** Предупреждение «сообщения не доходят» об одном чате — не чаще раза в сутки. */
const DELIVERY_WARN_EVERY_MS = 24 * 60 * 60_000;

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

/** Последняя настоящая отправка в чат и сколько неудач подряд к ней привело. */
interface DeliveryMark extends TelegramTestResult {
  fails: number;
  /** Когда об этом чате в последний раз предупреждали «сообщения не доходят». */
  warnedAt?: string | null;
}
/**
 * Отметки доставки по чатам — отдельным ключом, а не внутри настроек: их пишет каждая отправка, и запись
 * настроек целиком затёрла бы то, что владелец сохранил в эту же секунду.
 */
export interface DeliveryState {
  chats: Record<string, DeliveryMark>;
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

  /**
   * Настройки для интерфейса. `view` — то, чего нет в самой записи настроек: отметки настоящей доставки и
   * пояс, по которому панель считает тихие часы.
   */
  toPublic(
    s: Stored,
    view: { delivery: DeliveryState; timeZone: string; timeZoneChosen: boolean },
  ): TelegramSettings {
    return {
      destinations: s.destinations.map((d): TelegramDestination => {
        const mark = view.delivery.chats[d.id];
        return {
          id: d.id,
          masked: maskTelegramUrl(d.chatId, d.topic),
          chatId: d.chatId,
          topic: d.topic,
          botName: d.botName,
          chatTitle: d.chatTitle,
          lastTest: d.lastTest,
          lastDelivery: mark ? { at: mark.at, ok: mark.ok, detail: mark.detail } : null,
        };
      }),
      events: s.events,
      quiet: s.quiet,
      kinds: s.kinds,
      delivery: s.delivery,
      proxy: (() => {
        const p = this.proxy(s);
        return p ? maskTelegramProxy(p) : null;
      })(),
      timeZone: view.timeZone,
      timeZoneChosen: view.timeZoneChosen,
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

  /**
   * Группа стала супергруппой: у чата новый номер. Настройки перечитываем и меняем только его — между
   * чтением и записью нет похода в сеть, сохранённое владельцем в это время не затрётся.
   */
  async migrateChat(id: string, chatId: string): Promise<boolean> {
    const s = await this.load();
    const d = s.destinations.find((x) => x.id === id);
    if (!d || d.chatId === chatId) return false;
    d.chatId = chatId;
    await this.save(s);
    return true;
  }

  async deliveryState(): Promise<DeliveryState> {
    const p = await this.read<Partial<DeliveryState>>(DELIVERY_KEY);
    return { chats: p?.chats && typeof p.chats === 'object' ? p.chats : {} };
  }

  /** Отметки пишутся строго по очереди: отправки в разные чаты идут одновременно и затёрли бы друг друга. */
  private deliveryTurn: Promise<unknown> = Promise.resolve();

  private withDelivery<T>(fn: (st: DeliveryState, ids: Set<string>) => Promise<T>): Promise<T> {
    const run = async () => {
      const ids = new Set((await this.load()).destinations.map((d) => d.id));
      const st = await this.deliveryState();
      // Отметки удалённых чатов не храним.
      for (const id of Object.keys(st.chats)) if (!ids.has(id)) delete st.chats[id];
      return fn(st, ids);
    };
    const next = this.deliveryTurn.then(run, run);
    this.deliveryTurn = next.catch(() => undefined);
    return next;
  }

  /**
   * Итог настоящей отправки в сохранённый чат. `warn` — неудач подряд набралось достаточно, а об этом чате
   * сегодня ещё не предупреждали: пора сказать владельцу (и после этого вызвать `markDeliveryWarned`).
   * Чата нет в настройках (свой чат копий, несохранённый) — не пишем.
   */
  recordDelivery(
    id: string,
    ok: boolean,
    detail: string,
    now = new Date(),
  ): Promise<{ fails: number; warn: boolean }> {
    return this.withDelivery(async (st, ids) => {
      if (!ids.has(id)) return { fails: 0, warn: false };
      const fails = ok ? 0 : (st.chats[id]?.fails ?? 0) + 1;
      const warnedAt = st.chats[id]?.warnedAt ?? null;
      st.chats[id] = { at: now.toISOString(), ok, detail, fails, warnedAt };
      await this.write(DELIVERY_KEY, st);
      const warn =
        fails >= DELIVERY_FAILS_TO_WARN &&
        (!warnedAt || now.getTime() - Date.parse(warnedAt) >= DELIVERY_WARN_EVERY_MS);
      return { fails, warn };
    });
  }

  /** Владельцу сказали, что в эти чаты сообщения не доходят: сутки о них больше не напоминаем. */
  markDeliveryWarned(ids: string[], now = new Date()): Promise<void> {
    return this.withDelivery(async (st) => {
      for (const id of ids) {
        const mark = st.chats[id];
        if (mark) mark.warnedAt = now.toISOString();
      }
      await this.write(DELIVERY_KEY, st);
    });
  }

  /** Ручной тест чата прошёл — прежние неудачи не в счёт: следующая ошибка снова будет «первой». */
  clearDeliveryFails(id: string): Promise<void> {
    return this.withDelivery(async (st) => {
      const mark = st.chats[id];
      if (!mark || mark.fails === 0) return;
      mark.fails = 0;
      await this.write(DELIVERY_KEY, st);
    });
  }

  async digest(): Promise<DigestItem[]> {
    return (await this.read<DigestItem[]>(DIGEST_KEY)) ?? [];
  }

  async setDigest(items: DigestItem[]): Promise<void> {
    await this.write(DIGEST_KEY, items.slice(-50));
  }

  /** Сводка правится строго по очереди: ночные события разных дел приходят разом и затёрли бы друг друга. */
  private digestTurn: Promise<unknown> = Promise.resolve();

  private withDigest<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.digestTurn.then(fn, fn);
    this.digestTurn = next.catch(() => undefined);
    return next;
  }

  /** Дописать строку в утреннюю сводку. */
  addToDigest(item: DigestItem): Promise<void> {
    return this.withDigest(async () => this.setDigest([...(await this.digest()), item]));
  }

  /** Забрать накопленную сводку и очистить её — одним действием, чтобы строка «между» не потерялась. */
  takeDigest(): Promise<DigestItem[]> {
    return this.withDigest(async () => {
      const items = await this.digest();
      if (items.length > 0) await this.setDigest([]);
      return items;
    });
  }
}
