import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type IncidentKind,
  parseTelegramUrl,
  TELEGRAM_EVENT_LABELS,
  type TelegramEvent,
  type TelegramSettings,
  type TelegramSettingsUpdate,
  type TelegramTestRequest,
  type TelegramTestResponse,
} from '@nodeservice/shared';
import { and, asc, desc, eq } from 'drizzle-orm';

import type { Env } from '../../../config/env.schema.js';
import { DB, type Db } from '../../../infra/db/db.module.js';
import { telegramMessages } from '../../../infra/db/schema/index.js';
import { describeTelegramError, TELEGRAM_CLIENT, type TelegramClient } from './telegram.client.js';
import { esc, formatTelegramMessage, inQuietHours, localTime } from './telegram.format.js';
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
}

/** Со звуком при «Предупреждения без звука»: только то, что требует внимания сейчас. */
const LOUD = new Set<TelegramEvent>(['incident_crit', 'needs_confirm', 'login', 'reminder']);
/** Открытие сбоя — то, что склеивается по серверу. */
const OPENING = new Set<TelegramEvent>(['incident_crit', 'incident_warn', 'needs_confirm']);
const GROUP_WINDOW_MS = 10 * 60_000;

/** «Починилось» по одному инциденту не шлём дважды (шаг помог + автозакрытие идут почти подряд). */
const RESOLVED_DEDUP_MS = 10 * 60_000;

@Injectable()
export class TelegramService {
  private readonly log = new Logger(TelegramService.name);
  private readonly resolvedSent = new Map<string, number>();
  /** Последний «первый» сбой по серверу: к нему в течение 10 минут цепляются следующие. */
  private readonly lastByServer = new Map<string, { incidentId: string; at: number }>();

  constructor(
    private readonly store: TelegramSettingsStore,
    @Inject(TELEGRAM_CLIENT) private readonly client: TelegramClient,
    private readonly config: ConfigService<Env, true>,
    @Inject(DB) private readonly db: Db,
  ) {}

  async get(): Promise<TelegramSettings> {
    return this.store.toPublic(await this.store.load());
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
          const names = await this.lookupNames({ ...d, token: t.token });
          next.push({ ...d, ...names });
          added += 1;
        }
      }
      removed = cur.destinations.filter((d) => !next.some((n) => n.id === d.id)).length;
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
    await this.store.save(cur);
    return { settings: this.store.toPublic(cur), added, removed };
  }

  /** @имя бота и название чата — для подписи под строкой; ошибки не мешают сохранению. */
  private async lookupNames(
    d: LiveDestination,
  ): Promise<{ botName: string | null; chatTitle: string | null }> {
    const me = await this.client.call<{ username?: string }>(d.token, 'getMe', {}).catch(() => null);
    const chat = await this.client
      .call<{ title?: string; first_name?: string; type?: string }>(d.token, 'getChat', { chat_id: d.chatId })
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
    const names = await this.lookupNames(dest);
    const res = await this.send(
      dest,
      `✅ <b>NodeService</b>\nТестовое сообщение: уведомления в этот чат работают.${
        names.chatTitle ? `\n<i>${esc(names.chatTitle)}</i>` : ''
      }`,
      [],
      null,
    );
    const detail = res.ok ? 'Тест доставлен' : res.error;
    if (req.id) {
      const d = cur.destinations.find((x) => x.id === req.id);
      if (d) {
        d.lastTest = { at: new Date().toISOString(), ok: res.ok, detail };
        if (names.botName) d.botName = names.botName;
        if (names.chatTitle) d.chatTitle = names.chatTitle;
        await this.store.save(cur);
      }
    }
    return { ok: res.ok, detail, botName: names.botName, chatTitle: names.chatTitle };
  }

  private async send(
    d: LiveDestination,
    text: string,
    buttons: Array<{ text: string; url: string }>,
    replyTo: number | null,
    silent = false,
  ): Promise<{ ok: true; messageId: number } | { ok: false; error: string }> {
    const body: Record<string, unknown> = {
      chat_id: d.chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    if (d.topic !== null) body.message_thread_id = d.topic;
    if (replyTo !== null) body.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
    if (buttons.length > 0) body.reply_markup = { inline_keyboard: [buttons] };
    // Штатная возможность Bot API: сообщение приходит, но телефон не звенит.
    if (silent) body.disable_notification = true;
    const res = await this.client
      .call<{ message_id: number }>(d.token, 'sendMessage', body)
      .catch(() => null);
    if (!res) return { ok: false, error: describeTelegramError(0, 'network') };
    return res.ok
      ? { ok: true, messageId: res.result.message_id }
      : { ok: false, error: describeTelegramError(res.status, res.description) };
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

  /** Отправить событие во все чаты. Никогда не бросает: уведомление не должно ронять основную работу. */
  async dispatch(m: TelegramDispatch): Promise<void> {
    try {
      const s = await this.store.load();
      if (s.destinations.length === 0 || !s.events[m.event]) return;
      if (m.kind && !s.kinds[m.kind]) return;
      const now = new Date();
      if (m.event === 'resolved' && m.incidentId) {
        // Починилось — следующий сбой этого сервера уже новая беда: со звуком, не ответом на старую.
        for (const [key, v] of this.lastByServer)
          if (v.incidentId === m.incidentId) this.lastByServer.delete(key);
        const at = this.resolvedSent.get(m.incidentId);
        if (at && Date.now() - at < RESOLVED_DEDUP_MS) return;
        this.resolvedSent.set(m.incidentId, Date.now());
      }
      if (
        s.quiet.enabled &&
        m.event !== 'incident_crit' &&
        inQuietHours(now, s.quiet.from, s.quiet.to, s.quiet.timeZone)
      ) {
        const items = await this.store.digest();
        items.push({
          event: m.event,
          title: m.server ? `${m.title} · ${m.server.name}` : m.title,
          at: now.toISOString(),
        });
        await this.store.setDigest(items);
        return;
      }
      // Склейка по серверу: первый сбой — со звуком, следующий сбой того же сервера за 10 минут — ответом на
      // первый и тихо («агент не в сети» + «SSH недоступен» — одна беда, телефон не пищит дважды).
      let groupWith: string | null = null;
      if (m.incidentId && m.serverKey && OPENING.has(m.event) && s.delivery.groupPerServer) {
        const prev = this.lastByServer.get(m.serverKey);
        if (prev && prev.incidentId !== m.incidentId && Date.now() - prev.at < GROUP_WINDOW_MS)
          groupWith = prev.incidentId;
      }
      const silent = groupWith !== null || (s.delivery.silentWarnings && !LOUD.has(m.event));
      const text = formatTelegramMessage({
        event: m.event,
        title: m.title,
        body: m.body ?? null,
        server: m.server ?? null,
        footer: `${TELEGRAM_EVENT_LABELS[m.event]} · ${localTime(now, s.quiet.timeZone)}`,
      });
      const buttons = this.buttons(m.link, m.incidentId ?? null);
      let anyFirst = false;
      for (const d of this.store.live(s)) {
        // Всё после первого сообщения по инциденту — ответом на него; первое — ответом на сбой-соседа.
        const own = m.incidentId ? await this.firstMessage(m.incidentId, d.id) : null;
        const replyTo = own ?? (groupWith ? await this.firstMessage(groupWith, d.id) : null);
        const res = await this.send(d, text, buttons, replyTo, silent);
        if (!res.ok) {
          this.log.warn(`Telegram (${d.chatId}): ${res.error}`);
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
      if (anyFirst && m.serverKey && m.incidentId && groupWith === null)
        this.lastByServer.set(m.serverKey, { incidentId: m.incidentId, at: Date.now() });
    } catch (err) {
      this.log.warn(`Telegram: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Когда по инциденту в последний раз писали в Telegram (отсчёт для напоминаний); null — не писали. */
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
    if (s.quiet.enabled && inQuietHours(new Date(), s.quiet.from, s.quiet.to, s.quiet.timeZone)) return;
    const items = await this.store.digest();
    if (items.length === 0) return;
    await this.store.setDigest([]);
    if (s.destinations.length === 0) return;
    const lines = items
      .slice(-20)
      .map((i) => `• ${localTime(new Date(i.at), s.quiet.timeZone)} — ${esc(i.title)}`);
    const text = `🌅 <b>Пока были тихие часы</b>\n\n${lines.join('\n')}${
      items.length > 20 ? `\n…и ещё ${items.length - 20}` : ''
    }\n\n<i>Подробности — в «Инцидентах» и колокольчике панели.</i>`;
    for (const d of this.store.live(s)) {
      const res = await this.send(
        d,
        text,
        this.buttons({ to: '/incidents', label: 'Открыть инциденты' }),
        null,
      );
      if (!res.ok) this.log.warn(`Telegram (${d.chatId}): ${res.error}`);
    }
  }
}
