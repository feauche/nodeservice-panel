import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type IncidentKind,
  type NotificationSeverity,
  parseTelegramUrl,
  TELEGRAM_EVENT_LABELS,
  type TelegramEvent,
  type TelegramSettings,
  type TelegramSettingsUpdate,
  type TelegramTestRequest,
  type TelegramTestResponse,
} from '@nodeservice/shared';
import { and, asc, desc, eq, lte, sql } from 'drizzle-orm';
import { panelTimeZone } from '../../../common/panel-time-zone.js';
import type { Env } from '../../../config/env.schema.js';
import { DB, type Db } from '../../../infra/db/db.module.js';
import { telegramMessages, telegramOutbox } from '../../../infra/db/schema/index.js';
import { SYSTEM_ACTOR } from '../../audit/audit.context.js';
import { AuditService } from '../../audit/audit.service.js';
import { describeTelegramError, TELEGRAM_CLIENT, type TelegramClient } from './telegram.client.js';
import { esc, formatTelegramMessage, inQuietHours, localTime } from './telegram.format.js';
import {
  digestBlocks,
  isRichRejected,
  type RichBlock,
  richMessageBlocks,
  sampleBlocks,
} from './telegram.rich.js';
import {
  type LiveDestination,
  type StoredDestination,
  TelegramSettingsStore,
} from './telegram-settings.store.js';

export interface TelegramDispatch {
  event: TelegramEvent;
  /** Вид инцидента: выключенный в «Какие инциденты» не присылается совсем. */
  kind?: IncidentKind | null;
  /** Чей сбой: второй сбой того же сервера за 10 минут уходит ответом на первый и без звука. */
  serverKey?: string | null;
  title: string;
  body?: string | null;
  server?: { name: string; host?: string | null } | null;
  /** Инцидент: первое сообщение запоминается, «Починилось» уходит ответом на него. */
  incidentId?: string | null;
  /** Кнопка-ссылка в панель: путь внутри панели и подпись. */
  link?: { to: string; label: string } | null;
  /** Готовое HTML-сообщение: обычный вариант и запасной формат при отказе rich API. */
  html?: string | null;
  /** Готовые rich блоки для специальных сообщений, структура которых не выводится из body. */
  rich?: RichBlock[] | null;
  /**
   * Важность сбоя, о котором сообщение. Судим по ней, а не по типу события: первое сообщение о критичном
   * деле — его открытие, даже если оно пришло как «ждёт подтверждения» (панель сразу предложила шаг).
   */
  severity?: NotificationSeverity | null;
  /** Прислать без звука в любом случае: короткий сбой уже прошёл, будить некого. */
  silent?: boolean;
  /**
   * Сообщение пришло вместо несостоявшейся тревоги (короткий сбой): проходит и по её тумблеру. Иначе при
   * выключенном «Починилось» о сбое не пришло бы ничего — ни тревоги, ни вести о том, что он был.
   */
  replaces?: TelegramEvent | null;
}

/** Со звуком при «Предупреждения без звука»: только то, что требует внимания сейчас. */
const LOUD = new Set<TelegramEvent>([
  'incident_crit',
  'needs_confirm',
  'login',
  'reminder',
  'billing_overdue',
]);
/** Открытие сбоя — то, что склеивается по серверу. */
const OPENING = new Set<TelegramEvent>(['incident_crit', 'incident_warn', 'needs_confirm']);
/** Не ждут конца тихих часов, кроме критичных инцидентов: вход с нового устройства — это про безопасность. */
const NIGHT_NOW = new Set<TelegramEvent>(['login']);
const GROUP_WINDOW_MS = 10 * 60_000;

/**
 * Насколько громко сообщение о сбое: 2 — критичное, 1 — требует внимания сейчас (приходит со звуком),
 * 0 — тихое. По этому решается склейка по серверу: сбой глушится только равным или более важным.
 */
const rankOf = (event: TelegramEvent, crit: boolean): number => (crit ? 2 : LOUD.has(event) ? 1 : 0);

/** Чат, в который сообщения не доходят: для предупреждения владельцу. */
interface DeliveryTrouble {
  id: string;
  /** Как назвать чат в тексте: «VPN-алерты» в кавычках или «с номером …». */
  chat: string;
  fails: number;
  reason: string;
}

/** «3 сообщения», «5 сообщений», «21 сообщение». */
const messagesWord = (n: number): string =>
  n % 10 === 1 && n % 100 !== 11
    ? 'сообщение'
    : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
      ? 'сообщения'
      : 'сообщений';

/** «Починилось» по одному инциденту не шлём дважды (шаг помог + автозакрытие идут почти подряд). */
const RESOLVED_DEDUP_MS = 10 * 60_000;
/**
 * Telegram не принял расширенное оформление (старый сервер Bot API, не та разметка) — столько времени в этот
 * чат шлём сразу по-старому, а не пробуем каждый раз заново: каждая неудачная попытка — лишний запрос и
 * задержка тревоги.
 */
const RICH_RETRY_MS = 60 * 60_000;

/** Итог отправки. `plain` — сообщение ушло по-старому, потому что Telegram не принял расширенное оформление. */
type SendResult = { ok: true; messageId: number; plain?: string } | { ok: false; error: string };

/** Уже подготовленное сообщение одному чату: правила и тихие часы второй раз к нему не применяются. */
interface TelegramOutboxPayload {
  text: string;
  buttons: Array<{ text: string; url: string }>;
  replyTo: number | null;
  silent: boolean;
  rich: RichBlock[] | null;
  incidentId: string | null;
  event: TelegramEvent;
}

@Injectable()
export class TelegramService {
  private readonly log = new Logger(TelegramService.name);
  private readonly resolvedSent = new Map<string, number>();
  /**
   * Последний «главный» сбой по серверу: к нему в течение 10 минут цепляются следующие. `rank` — насколько
   * громко о нём сообщили (см. `rankOf`): тихое предупреждение не глушит критичный сбой, пришедший следом.
   */
  private readonly lastByServer = new Map<string, { incidentId: string; at: number; rank: number }>();
  /** Очередь отправки по серверу — для открытий сбоев, которые участвуют в склейке. */
  private readonly serverTurns = new Map<string, Promise<void>>();
  /** Когда Telegram в последний раз не принял расширенное оформление, по чатам (см. RICH_RETRY_MS). */
  private readonly richRejectedAt = new Map<string, number>();
  /** Минутная задача и ручной вызов не должны одновременно отправить одну запись outbox. */
  private outboxBusy = false;
  /**
   * Куда сказать владельцу, что сообщения не доходят: колокольчик панели. Задаёт центр уведомлений — сам
   * Telegram от него не зависит (иначе круг: центр уведомлений шлёт через Telegram).
   */
  bell: ((n: { title: string; body: string }) => Promise<void>) | null = null;

  constructor(
    private readonly store: TelegramSettingsStore,
    @Inject(TELEGRAM_CLIENT) private readonly client: TelegramClient,
    private readonly config: ConfigService<Env, true>,
    @Inject(DB) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<TelegramSettings> {
    return this.toPublic(await this.store.load());
  }

  /** Настройки для интерфейса — с отметками настоящей доставки и поясом, по которому идут тихие часы. */
  private async toPublic(s: Awaited<ReturnType<TelegramSettingsStore['load']>>): Promise<TelegramSettings> {
    const panel = await panelTimeZone(this.db);
    return this.store.toPublic(s, {
      delivery: await this.store.deliveryState(),
      timeZone: panel ?? s.quiet.timeZone,
      timeZoneChosen: panel !== null,
    });
  }

  async update(
    patch: TelegramSettingsUpdate,
  ): Promise<{ settings: TelegramSettings; added: number; removed: number }> {
    const cur = await this.store.load();
    let added = 0;
    let removed = 0;
    if (patch.destinations) {
      const next: StoredDestination[] = [];
      const seen = new Set<string>();
      const live = new Map(this.store.live(cur).map((d) => [d.id, d]));
      for (const item of patch.destinations) {
        if ('id' in item) {
          const keep = cur.destinations.find((d) => d.id === item.id);
          const l = live.get(item.id);
          if (!keep || !l) continue;
          const sig = `${l.token}|${keep.chatId}|${keep.topic ?? ''}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          next.push(keep);
        } else {
          const t = parseTelegramUrl(item.url);
          if (!t) continue;
          const sig = `${t.token}|${t.chatId}|${t.topic ?? ''}`;
          if (seen.has(sig)) continue;
          seen.add(sig);
          const d = this.store.newDestination(t.token, t.chatId, t.topic);
          const proxy = patch.proxy === undefined ? this.store.proxy(cur) : patch.proxy ? patch.proxy : null;
          const names = await this.lookupNames({ ...d, token: t.token, proxy });
          next.push({ ...d, ...names });
          added += 1;
        }
      }
      removed = cur.destinations.filter((d) => !next.some((n) => n.id === d.id)).length;
      // Пока панель спрашивала у Telegram имена новых чатов, у сохранённого могли смениться номер (группа
      // стала супергруппой) или отметка теста — берём их свежими, а не затираем прочитанным в начале.
      if (added > 0) {
        const fresh = new Map((await this.store.load()).destinations.map((d) => [d.id, d]));
        for (const d of next) {
          const latest = fresh.get(d.id);
          if (latest) Object.assign(d, { chatId: latest.chatId, lastTest: latest.lastTest });
        }
      }
      cur.destinations = next;
    }
    if (patch.events)
      for (const [k, v] of Object.entries(patch.events))
        if (typeof v === 'boolean') cur.events[k as TelegramEvent] = v;
    if (patch.quiet) cur.quiet = patch.quiet;
    if (patch.kinds)
      for (const [k, v] of Object.entries(patch.kinds))
        if (typeof v === 'boolean') cur.kinds[k as IncidentKind] = v;
    if (patch.delivery) cur.delivery = patch.delivery;
    // Прокси: не передан — как было; пусто или null — убрать; иначе — новый (с паролем шифруется).
    if (patch.proxy !== undefined) cur.proxyEnc = patch.proxy ? this.store.encryptProxy(patch.proxy) : null;
    await this.store.save(cur);
    return { settings: await this.toPublic(cur), added, removed };
  }

  /** @имя бота и название чата — для подписи под строкой; ошибки не мешают сохранению. */
  private async lookupNames(
    d: LiveDestination,
  ): Promise<{ botName: string | null; chatTitle: string | null }> {
    const me = await this.client
      .call<{ username?: string }>(d.token, 'getMe', {}, d.proxy ?? null)
      .catch(() => null);
    const chat = await this.client
      .call<{ title?: string; first_name?: string; type?: string }>(
        d.token,
        'getChat',
        { chat_id: d.chatId },
        d.proxy ?? null,
      )
      .catch(() => null);
    const title = chat?.ok
      ? (chat.result.title ??
        (chat.result.type === 'private' ? 'Личный чат' : (chat.result.first_name ?? null)))
      : null;
    return {
      botName: me?.ok && me.result.username ? `@${me.result.username}` : null,
      chatTitle: title,
    };
  }

  async test(req: TelegramTestRequest): Promise<TelegramTestResponse> {
    const cur = await this.store.load();
    let dest: LiveDestination | null;
    if (req.id) dest = this.store.live(cur).find((d) => d.id === req.id) ?? null;
    else {
      const t = parseTelegramUrl(req.url ?? '');
      dest = t
        ? {
            id: 'unsaved',
            chatId: t.chatId,
            topic: t.topic,
            token: t.token,
            botName: null,
            chatTitle: null,
            lastTest: null,
          }
        : null;
    }
    if (!dest) return { ok: false, detail: 'Такого чата нет в настройках.', botName: null, chatTitle: null };
    // Прокси для теста: как в поле сейчас (даже несохранённый); не передан — сохранённый.
    dest = { ...dest, proxy: req.proxy === undefined ? this.store.proxy(cur) : req.proxy || null };
    const names = await this.lookupNames(dest);
    // Расширенное оформление — как в переключателе сейчас: по образцу владелец видит, показывает ли его
    // приложение Telegram такие сообщения. Прошлый отказ Telegram здесь не в счёт: тест пробует заново.
    const rich = req.rich ?? cur.delivery.rich;
    const res = await this.send(
      dest,
      `✅ <b>NodeService</b>\nТестовое сообщение: уведомления в этот чат работают.${
        names.chatTitle ? `\n<i>${esc(names.chatTitle)}</i>` : ''
      }`,
      [],
      null,
      false,
      rich ? sampleBlocks(names.chatTitle) : null,
      true,
    );
    const detail = !res.ok
      ? res.error
      : res.plain
        ? `Тест доставлен обычным сообщением: расширенное оформление Telegram не принял (${res.plain})`
        : rich
          ? 'Тест доставлен в расширенном оформлении — если в чате видна таблица, его можно включать'
          : 'Тест доставлен';
    if (req.id) {
      // Настройки перечитываем: пока шёл тест, у чата мог смениться номер (группа стала супергруппой).
      const now = await this.store.load();
      const d = now.destinations.find((x) => x.id === req.id);
      if (d) {
        d.lastTest = { at: new Date().toISOString(), ok: res.ok, detail };
        if (names.botName) d.botName = names.botName;
        if (names.chatTitle) d.chatTitle = names.chatTitle;
        await this.store.save(now);
      }
      // Чат проверен и работает — прежние неудачи настоящих отправок больше не «подряд».
      if (res.ok) await this.store.clearDeliveryFails(req.id).catch(() => undefined);
    }
    return { ok: res.ok, detail, botName: names.botName, chatTitle: names.chatTitle };
  }

  /**
   * Сообщение в чат. `rich` — то же сообщение блоками (расширенное оформление): Telegram его не принял
   * (старый сервер Bot API, не та разметка) — сразу шлём `text` по-старому, тревога не теряется. Сеть, лимит
   * частоты или «чат не найден» — не про оформление: второй раз не шлём, иначе сообщение могло бы прийти
   * дважды. `forceRich` — пробовать оформление, даже если недавно был отказ (кнопка «Отправить тест»).
   */
  private async send(
    d: LiveDestination,
    text: string,
    buttons: Array<{ text: string; url: string }>,
    replyTo: number | null,
    silent = false,
    rich: RichBlock[] | null = null,
    forceRich = false,
  ): Promise<SendResult> {
    const common: Record<string, unknown> = {};
    if (d.topic !== null) common.message_thread_id = d.topic;
    if (replyTo !== null)
      common.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    if (buttons.length > 0) common.reply_markup = { inline_keyboard: [buttons] };
    // Штатная возможность Bot API: сообщение приходит, но телефон не звенит.
    if (silent) common.disable_notification = true;
    let plain: string | undefined;
    const lastRejected = this.richRejectedAt.get(d.id);
    if (rich && (forceRich || !lastRejected || Date.now() - lastRejected > RICH_RETRY_MS)) {
      // Текст блоков экранировать не нужно; распознавание ссылок и упоминаний выключено — адреса серверов и
      // имена не должны становиться ссылками.
      const res = await this.post(d, 'sendRichMessage', {
        ...common,
        rich_message: { blocks: rich, skip_entity_detection: true },
      });
      if (res.ok || !res.rejected) return res;
      this.richRejectedAt.set(d.id, Date.now());
      plain = res.error;
    }
    const res = await this.post(d, 'sendMessage', {
      ...common,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    return res.ok ? { ...res, ...(plain ? { plain } : {}) } : res;
  }

  /**
   * Один вызов метода отправки. Группа стала супергруппой — Telegram называет новый номер чата: запоминаем его
   * и отправляем туда же, иначе это сообщение пропало бы, а все следующие падали бы с той же ошибкой.
   * `rejected` — отказ относится к самому расширенному оформлению (см. isRichRejected).
   */
  private async post(
    d: LiveDestination,
    method: 'sendMessage' | 'sendRichMessage',
    body: Record<string, unknown>,
  ): Promise<{ ok: true; messageId: number } | { ok: false; error: string; rejected: boolean }> {
    const call = (chatId: string) =>
      this.client
        .call<{ message_id: number }>(d.token, method, { ...body, chat_id: chatId }, d.proxy ?? null)
        .catch(() => null);
    let res = await call(d.chatId);
    if (res && !res.ok && res.migrateToChatId && res.migrateToChatId !== d.chatId) {
      await this.chatMoved(d, res.migrateToChatId);
      res = await call(res.migrateToChatId);
    }
    if (!res) return { ok: false, error: describeTelegramError(0, 'network'), rejected: false };
    if (res.ok) return { ok: true, messageId: res.result.message_id };
    // Ответ Telegram как есть — только в лог; владельцу уходит причина по-русски.
    if (res.status !== 0)
      this.log.warn(`Telegram (${d.chatId}, ${method}) ответил ${res.status}: ${res.description}`);
    return {
      ok: false,
      error: describeTelegramError(res.status, res.description),
      rejected: method === 'sendRichMessage' && isRichRejected(res.status, res.description),
    };
  }

  /** У сохранённого чата новый номер: правим настройки и оставляем след в Журнале. */
  private async chatMoved(d: LiveDestination, chatId: string): Promise<void> {
    const saved = await this.store.migrateChat(d.id, chatId).catch(() => false);
    if (!saved) return;
    await this.audit.record({
      action: 'settings.telegram.chat_migrated',
      actor: SYSTEM_ACTOR,
      source: 'auto',
      target: { type: 'settings', id: 'telegram', display: 'Уведомления в Telegram' },
      metadata: {
        note: `${d.chatTitle ? `Чат «${d.chatTitle}»` : 'Чат'}: номер ${d.chatId} заменён на ${chatId}`,
      },
    });
  }

  /**
   * Отметка настоящей отправки у чата. Возвращает чат, о котором пора сказать владельцу: неудач подряд
   * набралось достаточно, а об этом чате сегодня ещё не предупреждали.
   */
  private async noteDelivery(
    d: LiveDestination,
    res: { ok: true; plain?: string } | { ok: false; error: string },
  ): Promise<DeliveryTrouble | null> {
    try {
      const { fails, warn } = await this.store.recordDelivery(
        d.id,
        res.ok,
        !res.ok
          ? res.error
          : res.plain
            ? 'Доставлено обычным сообщением: Telegram не принял расширенное оформление'
            : 'Доставлено',
      );
      if (res.ok || !warn) return null;
      return {
        id: d.id,
        chat: d.chatTitle ? `«${d.chatTitle}»` : `с номером ${d.chatId}`,
        fails,
        reason: res.error,
      };
    } catch (err) {
      this.log.warn(`Telegram: отметка доставки не записана: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /**
   * Сообщения не доходят: говорим владельцу в колокольчик и пишем в Журнал — иначе он уверен, что тревоги
   * приходят, а они не доходят неделями. Одно предупреждение на все чаты, набравшие неудачи этой отправкой
   * (пропала связь с Telegram — чатов много, беда одна); о каждом чате — не чаще раза в сутки.
   */
  private async warnUndelivered(list: DeliveryTrouble[]): Promise<void> {
    if (list.length === 0) return;
    try {
      const notes = list.map(
        (t) => `В чат ${t.chat} не доставлено ${t.fails} ${messagesWord(t.fails)} подряд.`,
      );
      const withReasons = list.map((t, i) => `${notes[i]} Причина: ${t.reason}`).join(' ');
      await this.audit.record({
        action: 'settings.telegram.delivery_failed',
        actor: SYSTEM_ACTOR,
        source: 'auto',
        result: 'failed',
        severity: 'warn',
        target: { type: 'settings', id: 'telegram', display: 'Уведомления в Telegram' },
        metadata: list.length === 1 ? { note: notes[0], reason: list[0]?.reason } : { note: withReasons },
      });
      await this.bell?.({
        title: 'Сообщения в Telegram не доходят',
        body: `${withReasons} Пока это не исправлено, ${
          list.length > 1 ? 'в эти чаты' : 'в этот чат'
        } тревоги не приходят.`,
      });
      // Отметку «предупредили» ставим после: не вышло сказать — скажем при следующей неудаче.
      await this.store.markDeliveryWarned(list.map((t) => t.id));
    } catch (err) {
      this.log.warn(`Telegram: предупреждение о доставке: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Кнопки-ссылки только для настоящего адреса по https: Telegram не принимает localhost и http. */
  private buttons(
    link: TelegramDispatch['link'],
    incidentId?: string | null,
  ): Array<{ text: string; url: string }> {
    const base = this.config.get('PUBLIC_URL', { infer: true });
    if (!base?.startsWith('https://')) return [];
    const out: Array<{ text: string; url: string }> = [];
    if (link) out.push({ text: link.label, url: new URL(link.to, base).toString() });
    if (incidentId)
      out.push({
        text: 'Разбор Джарвиса',
        url: new URL(`/incidents/${incidentId}#analysis`, base).toString(),
      });
    return out.slice(0, 2);
  }

  /**
   * Отправить событие во все чаты. Никогда не бросает: уведомление не должно ронять основную работу.
   * Открытия сбоев одного сервера идут по очереди: отпущенные разом (после перезапуска, по общему сроку
   * ожидания), они иначе не увидели бы друг друга в склейке, и оба пришли бы со звуком.
   */
  dispatch(m: TelegramDispatch): Promise<void> {
    const key = m.incidentId && m.serverKey && OPENING.has(m.event) ? m.serverKey : null;
    if (!key) return this.deliver(m);
    const next = (this.serverTurns.get(key) ?? Promise.resolve()).then(() => this.deliver(m));
    this.serverTurns.set(key, next);
    void next.then(() => {
      if (this.serverTurns.get(key) === next) this.serverTurns.delete(key);
    });
    return next;
  }

  private async deliver(m: TelegramDispatch): Promise<void> {
    try {
      const s = await this.store.load();
      if (s.destinations.length === 0) return;
      if (m.kind && !s.kinds[m.kind]) return;
      // Первое сообщение о деле — его открытие, каким бы событием оно ни пришло. Панель сразу предложила
      // шаг — открытие приходит как «ждёт подтверждения», но решает его важность, а не тип события.
      const crit = m.event === 'incident_crit' || m.severity === 'crit';
      const opening =
        Boolean(m.incidentId) &&
        OPENING.has(m.event) &&
        (await this.lastMessageAt(m.incidentId as string)) === null;
      // Тумблер «Нужно ваше „Да“» не глушит само открытие инцидента: за него отвечает тумблер его важности.
      // Прошло только как открытие — и звук у него как у открытия: предупреждение остаётся тихим.
      const asOpening: TelegramEvent | null = opening ? (crit ? 'incident_crit' : 'incident_warn') : null;
      const soundAs = asOpening && !s.events[m.event] ? asOpening : m.event;
      if (!s.events[soundAs] && !(m.replaces && s.events[m.replaces])) return;
      const now = new Date();
      if (m.event === 'resolved' && m.incidentId) {
        // Починилось — следующий сбой этого сервера уже новая беда: со звуком, не ответом на старую.
        for (const [key, v] of this.lastByServer)
          if (v.incidentId === m.incidentId) this.lastByServer.delete(key);
        const at = this.resolvedSent.get(m.incidentId);
        if (at && Date.now() - at < RESOLVED_DEDUP_MS) return;
        this.resolvedSent.set(m.incidentId, Date.now());
      }
      // Пояс панели — тот же, что у времени в подписи: тихие часы и подпись не должны жить в разных поясах.
      const zone = (await panelTimeZone(this.db)) ?? s.quiet.timeZone;
      // Ночью не ждут утра: критичный инцидент (в том числе открытый сразу с предложением шага) и вход
      // в панель. Остальное копится в утреннюю сводку.
      const urgent = m.event === 'incident_crit' || (opening && crit) || NIGHT_NOW.has(m.event);
      if (s.quiet.enabled && !urgent && inQuietHours(now, s.quiet.from, s.quiet.to, zone)) {
        await this.store.addToDigest({
          event: m.event,
          title: m.server ? `${m.title} · ${m.server.name}` : m.title,
          at: now.toISOString(),
        });
        return;
      }
      // Склейка по серверу: первый сбой — со звуком, следующий сбой того же сервера за 10 минут — ответом на
      // первый и тихо («агент не в сети» + «SSH недоступен» — одна беда, телефон не пищит дважды).
      let head: { incidentId: string; rank: number } | null = null;
      if (m.incidentId && m.serverKey && OPENING.has(m.event) && s.delivery.groupPerServer) {
        const prev = this.lastByServer.get(m.serverKey);
        if (prev && prev.incidentId !== m.incidentId && Date.now() - prev.at < GROUP_WINDOW_MS) head = prev;
      }
      // Глушит только сбой не менее важный, о котором телефон уже пищал: критичное после тихого
      // предупреждения («память на пределе» → «сервер завис») приходит со звуком, хоть и ответом на него.
      const rank = rankOf(soundAs, crit);
      const glued = head !== null && head.rank >= rank;
      const silent = m.silent === true || glued || (s.delivery.silentWarnings && !LOUD.has(soundAs));
      const text =
        m.html ??
        formatTelegramMessage({
          event: m.event,
          title: m.title,
          body: m.body ?? null,
          server: m.server ?? null,
          // Время — по поясу панели, как и в тексте сообщения (срок оплаты): иначе в одном сообщении два пояса.
          footer: `${TELEGRAM_EVENT_LABELS[m.event]} · ${localTime(now, zone)}`,
        });
      // Специальное сообщение может передать готовую таблицу; для остальных блоки строятся из title/body.
      const rich = s.delivery.rich
        ? (m.rich ??
          (!m.html
            ? richMessageBlocks({
                event: m.event,
                title: m.title,
                body: m.body ?? null,
                server: m.server ?? null,
                footer: `${TELEGRAM_EVENT_LABELS[m.event]} · ${localTime(now, zone)}`,
              })
            : null))
        : null;
      const buttons = this.buttons(m.link, m.incidentId ?? null);
      let anyFirst = false;
      const undelivered: DeliveryTrouble[] = [];
      for (const d of this.store.live(s)) {
        // Всё после первого сообщения по инциденту — ответом на него; первое — ответом на сбой-соседа.
        const own = m.incidentId ? await this.firstMessage(m.incidentId, d.id) : null;
        const replyTo = own ?? (head ? await this.firstMessage(head.incidentId, d.id) : null);
        const res = await this.send(d, text, buttons, replyTo, silent, rich);
        const trouble = await this.noteDelivery(d, res);
        if (trouble) undelivered.push(trouble);
        if (!res.ok) {
          this.log.warn(`Telegram (${d.chatId}): ${res.error}`);
          await this.enqueueDelivery(d.id, {
            text,
            buttons,
            replyTo,
            silent,
            rich,
            incidentId: m.incidentId ?? null,
            event: m.event,
          });
          continue;
        }
        if (m.incidentId && own === null && m.event !== 'resolved') {
          anyFirst = true;
          await this.db
            .insert(telegramMessages)
            .values({ incidentId: m.incidentId, destinationId: d.id, messageId: res.messageId })
            .catch(() => undefined);
        }
      }
      // Главным по серверу становится первый сбой — или более важный, если до него были только тихие.
      if (anyFirst && m.serverKey && m.incidentId && !glued)
        this.lastByServer.set(m.serverKey, {
          incidentId: m.incidentId,
          at: Date.now(),
          rank: silent ? 0 : rank,
        });
      await this.warnUndelivered(undelivered);
    } catch (err) {
      this.log.warn(`Telegram: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Неудача одного чата не влияет на уже доставленные: повторяется только этот адресат. */
  private async enqueueDelivery(destinationId: string, payload: TelegramOutboxPayload): Promise<void> {
    await this.db
      .insert(telegramOutbox)
      .values({
        destinationId,
        payload: payload as unknown as Record<string, unknown>,
        nextAttemptAt: new Date(Date.now() + 30_000),
      })
      .catch((err: unknown) =>
        this.log.warn(
          `Telegram: сообщение не поставлено на повтор: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }

  /**
   * Повторить накопленные доставки по порядку. Очередь хранится в PostgreSQL, поэтому переживает рестарт.
   * Интервал растёт от минуты до шести часов; записи не удаляются по числу попыток — тревога не теряется.
   */
  async retryOutbox(now = new Date()): Promise<number> {
    if (this.outboxBusy) return 0;
    this.outboxBusy = true;
    try {
      const rows = await this.db
        .select()
        .from(telegramOutbox)
        .where(lte(telegramOutbox.nextAttemptAt, now))
        .orderBy(asc(telegramOutbox.createdAt))
        .limit(20);
      if (rows.length === 0) return 0;
      const settings = await this.store.load();
      const destinations = new Map(
        this.store.live(settings).map((destination) => [destination.id, destination]),
      );
      const troubles: DeliveryTrouble[] = [];
      // Если старшая доставка одного чата снова не прошла, младшие в этом же запуске не обгоняют её.
      // Иначе «Починилось» могло прийти раньше самой тревоги.
      const blockedDestinations = new Set<string>();
      let delivered = 0;
      for (const row of rows) {
        if (blockedDestinations.has(row.destinationId)) continue;
        const destination = destinations.get(row.destinationId);
        if (!destination) {
          // Чат удалён владельцем: отправлять токеном из старых настроек уже нельзя.
          await this.db.delete(telegramOutbox).where(eq(telegramOutbox.id, row.id));
          continue;
        }
        // В выборку попадают только записи, срок повтора которых наступил. Более старая запись этого чата
        // может ждать своего backoff; пока она есть, отправлять следующую нельзя.
        const older = await this.db.execute<{ present: boolean }>(sql`
          select exists (
            select 1
            from telegram_outbox as previous
            where previous.destination_id = ${row.destinationId}
              and (
                previous.created_at < ${row.createdAt}
                or (previous.created_at = ${row.createdAt} and previous.id < ${row.id})
              )
          ) as present
        `);
        if (older.rows[0]?.present) {
          blockedDestinations.add(row.destinationId);
          continue;
        }
        const payload = row.payload as unknown as TelegramOutboxPayload;
        if (!payload || typeof payload.text !== 'string' || !Array.isArray(payload.buttons)) {
          this.log.warn(`Telegram: повреждённая запись очереди ${row.id} удалена`);
          await this.db.delete(telegramOutbox).where(eq(telegramOutbox.id, row.id));
          continue;
        }
        // Если исходная тревога тем временем дошла другим повтором, последующие события отвечают уже на неё.
        const own = payload.incidentId
          ? await this.firstMessage(payload.incidentId, destination.id).catch(() => null)
          : null;
        const replyTo = own ?? payload.replyTo;
        const result = await this.send(
          destination,
          payload.text,
          payload.buttons,
          replyTo,
          payload.silent,
          payload.rich,
        );
        const trouble = await this.noteDelivery(destination, result);
        if (trouble) troubles.push(trouble);
        if (result.ok) {
          if (payload.incidentId && own === null && payload.event !== 'resolved')
            await this.db
              .insert(telegramMessages)
              .values({
                incidentId: payload.incidentId,
                destinationId: destination.id,
                messageId: result.messageId,
              })
              .catch(() => undefined);
          await this.db.delete(telegramOutbox).where(eq(telegramOutbox.id, row.id));
          delivered += 1;
          continue;
        }
        const attempts = row.attempts + 1;
        const waitMs = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(attempts, 9));
        await this.db
          .update(telegramOutbox)
          .set({ attempts, lastError: result.error, nextAttemptAt: new Date(now.getTime() + waitMs) })
          .where(eq(telegramOutbox.id, row.id));
        blockedDestinations.add(row.destinationId);
      }
      await this.warnUndelivered(troubles);
      return delivered;
    } finally {
      this.outboxBusy = false;
    }
  }

  /** Когда по инциденту в последний раз писали в Telegram (отсчёт для напоминаний); null — не писали. */
  /**
   * Куда слать служебное (резервные копии): чат из «Уведомлений» по id или свой чат строкой tgram://.
   * Прокси — общий из «Уведомлений». null — чат не найден или строка неверная.
   */
  async resolveTarget(
    target: { destinationId: string | null } | { url: string },
  ): Promise<LiveDestination | null> {
    const s = await this.store.load();
    const proxy = this.store.proxy(s);
    if ('url' in target) {
      const t = parseTelegramUrl(target.url);
      return t
        ? {
            id: 'own',
            chatId: t.chatId,
            topic: t.topic,
            token: t.token,
            botName: null,
            chatTitle: null,
            lastTest: null,
            proxy,
          }
        : null;
    }
    return this.store.live(s).find((d) => d.id === target.destinationId) ?? null;
  }

  /**
   * Все сохранённые чаты с токенами и общим прокси — для сторожа панели: он пишет в Telegram сам, когда панели
   * нет. Наружу не отдаётся.
   */
  async destinations(): Promise<LiveDestination[]> {
    return this.store.live(await this.store.load());
  }

  /** Текст в указанный чат (без правил «что присылать»: это служебные сообщения о копиях). */
  async sendTo(
    d: LiveDestination,
    html: string,
    silent = false,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await this.send(d, html, [], null, silent);
    const trouble = await this.noteDelivery(d, res);
    if (trouble) await this.warnUndelivered([trouble]);
    return res.ok ? { ok: true } : res;
  }

  /** Файл в указанный чат (до 50 МБ). */
  async sendFileTo(
    d: LiveDestination,
    file: { path: string; name: string },
    caption: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const fields: Record<string, string> = { chat_id: d.chatId, caption, parse_mode: 'HTML' };
    if (d.topic !== null) fields.message_thread_id = String(d.topic);
    const call = (chatId: string) =>
      this.client.sendFile(d.token, { ...fields, chat_id: chatId }, file, d.proxy ?? null).catch(() => null);
    let res = await call(d.chatId);
    // Группа стала супергруппой — как и с сообщениями: запоминаем новый номер чата и отправляем туда.
    if (res && !res.ok && res.migrateToChatId && res.migrateToChatId !== d.chatId) {
      await this.chatMoved(d, res.migrateToChatId);
      res = await call(res.migrateToChatId);
    }
    if (!res) return { ok: false, error: describeTelegramError(0, 'network') };
    if (res.ok) return { ok: true };
    if (res.status !== 0) this.log.warn(`Telegram (${d.chatId}) ответил ${res.status}: ${res.description}`);
    return { ok: false, error: describeTelegramError(res.status, res.description) };
  }

  /** Часовой пояс панели (из «Внешнего вида», иначе — из настроек уведомлений) — для времени в сообщениях. */
  async timeZone(): Promise<string> {
    // Сначала общий пояс панели («Внешний вид»), иначе — пояс браузера, сохранённый с тихими часами.
    return (await panelTimeZone(this.db)) ?? (await this.store.load()).quiet.timeZone;
  }

  async lastMessageAt(incidentId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: telegramMessages.createdAt })
      .from(telegramMessages)
      .where(eq(telegramMessages.incidentId, incidentId))
      .orderBy(desc(telegramMessages.createdAt))
      .limit(1);
    return row?.at ?? null;
  }

  /** Отметка «напомнили»: следующее напоминание отсчитывается от неё (ответы всё равно на первое). */
  async markReminded(incidentId: string): Promise<void> {
    await this.db
      .insert(telegramMessages)
      .values({ incidentId, destinationId: 'reminder', messageId: 0 })
      .catch(() => undefined);
  }

  /** Через сколько часов напоминать; null — напоминания выключены или чатов нет. */
  async remindHours(): Promise<number | null> {
    const s = await this.store.load();
    if (s.destinations.length === 0 || !s.events.reminder) return null;
    return s.delivery.remindHours;
  }

  private async firstMessage(incidentId: string, destinationId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ messageId: telegramMessages.messageId })
      .from(telegramMessages)
      .where(
        and(eq(telegramMessages.incidentId, incidentId), eq(telegramMessages.destinationId, destinationId)),
      )
      .orderBy(asc(telegramMessages.createdAt))
      .limit(1);
    return row?.messageId ?? null;
  }

  /** После тихих часов — одна сводка того, что копилось ночью. */
  async flushDigest(): Promise<void> {
    const s = await this.store.load();
    // Тихие часы — по поясу панели, как и время в самой сводке.
    const timeZone = (await panelTimeZone(this.db)) ?? s.quiet.timeZone;
    if (s.quiet.enabled && inQuietHours(new Date(), s.quiet.from, s.quiet.to, timeZone)) return;
    const items = await this.store.takeDigest();
    if (items.length === 0) return;
    if (s.destinations.length === 0) return;
    const shown = items.slice(-20);
    const lines = shown.map((i) => `• ${localTime(new Date(i.at), timeZone)} — ${esc(i.title)}`);
    const text = `🌅 <b>Пока были тихие часы</b>\n\n${lines.join('\n')}${
      items.length > 20 ? `\n…и ещё ${items.length - 20}` : ''
    }\n\n<i>Подробности — в «Инцидентах» и колокольчике панели.</i>`;
    const rich = s.delivery.rich
      ? digestBlocks(
          shown.map((i) => ({ time: localTime(new Date(i.at), timeZone), title: i.title })),
          Math.max(0, items.length - 20),
        )
      : null;
    const buttons = this.buttons({ to: '/incidents', label: 'Открыть инциденты' });
    const undelivered: DeliveryTrouble[] = [];
    for (const d of this.store.live(s)) {
      const res = await this.send(d, text, buttons, null, false, rich);
      const trouble = await this.noteDelivery(d, res);
      if (trouble) undelivered.push(trouble);
      if (!res.ok) {
        this.log.warn(`Telegram (${d.chatId}): ${res.error}`);
        // Сводка уже атомарно снята из app_meta. Сохраняем готовую адресную доставку в PostgreSQL,
        // иначе обрыв ровно после тихих часов удалил бы всю ночь событий без повторной попытки.
        await this.enqueueDelivery(d.id, {
          text,
          buttons,
          replyTo: null,
          silent: false,
          rich,
          incidentId: null,
          event: 'maintenance',
        });
      }
    }
    await this.warnUndelivered(undelivered);
  }
}
