import { z } from 'zod';

/**
 * Уведомления в Telegram (R6). Назначение задаётся одной строкой-ссылкой `tgram://токен/чат[:тема]` —
 * формат как у Apprise: токен бота от @BotFather, id чата (личный — положительный, группа — `-100…`),
 * номер темы для групп с темами. Назначений сколько угодно, у каждого свой бот. Токен после сохранения
 * не отдаётся наружу никогда: только маска `tgram://•••/чат:тема`.
 */

export const TELEGRAM_EVENTS = [
  'incident_crit',
  'incident_warn',
  'needs_confirm',
  'resolved',
  'maintenance',
  'jarvis_card',
  'login',
] as const;
export const telegramEventSchema = z.enum(TELEGRAM_EVENTS);
export type TelegramEvent = z.infer<typeof telegramEventSchema>;

export const TELEGRAM_EVENT_LABELS: Record<TelegramEvent, string> = {
  incident_crit: 'Критичный инцидент',
  incident_warn: 'Предупреждение',
  needs_confirm: 'Нужно ваше «Да»',
  resolved: 'Починилось',
  maintenance: 'Обслуживание',
  jarvis_card: 'Карточка Джарвиса ждёт решения',
  login: 'Вход в панель с нового устройства',
};
export const TELEGRAM_EVENT_HINTS: Record<TelegramEvent, string> = {
  incident_crit: 'Сервер или агент недоступен, нода упала, похоже на блокировку.',
  incident_warn: 'Высокая нагрузка, диск заполняется, онлайн упал без подтверждённой блокировки.',
  needs_confirm: 'Автопочинка предлагает шаг и ждёт подтверждения — или нужно вмешаться вручную.',
  resolved: 'Инцидент закрыт — сам или после шага. Приходит ответом на исходное сообщение.',
  maintenance: 'Есть обновления безопасности, нужна перезагрузка, агент устарел. Раз в сутки, не чаще.',
  jarvis_card: 'Джарвис предложил изменение или тяжёлую проверку.',
  login: 'И серия неудачных попыток входа.',
};
/** Метка важности рядом с названием (как в витрине K1); null — без метки. */
export const TELEGRAM_EVENT_TONE: Record<TelegramEvent, 'crit' | 'warn' | 'ok' | null> = {
  incident_crit: 'crit',
  incident_warn: 'warn',
  needs_confirm: null,
  resolved: 'ok',
  maintenance: null,
  jarvis_card: null,
  login: null,
};
export const TELEGRAM_EVENT_GROUPS: ReadonlyArray<{ title: string; keys: readonly TelegramEvent[] }> = [
  { title: 'Инциденты', keys: ['incident_crit', 'incident_warn', 'needs_confirm', 'resolved'] },
  { title: 'Серверы и Джарвис', keys: ['maintenance', 'jarvis_card'] },
  { title: 'Безопасность', keys: ['login'] },
];

export type TelegramEvents = Record<TelegramEvent, boolean>;
export const TELEGRAM_EVENTS_DEFAULT: TelegramEvents = {
  incident_crit: true,
  incident_warn: true,
  needs_confirm: true,
  resolved: true,
  maintenance: false,
  jarvis_card: false,
  login: true,
};

/** Сколько назначений можно завести — чтобы случайная вставка не превратилась в рассылку. */
export const TELEGRAM_DESTINATIONS_MAX = 10;

/** `tgram://123456789:AA…/-1001234567890:8` — токен, чат, необязательная тема. */
const TGRAM_RE = /^tgram:\/\/(\d{5,}:[A-Za-z0-9_-]{20,})\/(-?\d{3,20})(?::(\d{1,10}))?\/?$/;

export interface TelegramTarget {
  token: string;
  chatId: string;
  topic: number | null;
}

export function parseTelegramUrl(raw: string): TelegramTarget | null {
  const m = TGRAM_RE.exec(raw.trim());
  if (!m) return null;
  const [, token, chatId, topic] = m;
  if (!token || !chatId) return null;
  return { token, chatId, topic: topic ? Number(topic) : null };
}

export function maskTelegramUrl(chatId: string, topic: number | null): string {
  return `tgram://***/${chatId}${topic !== null ? `:${topic}` : ''}`;
}

export const telegramTestResultSchema = z.object({
  at: z.string(),
  ok: z.boolean(),
  /** Что показать человеку: «доставлено» или понятная причина отказа Telegram. */
  detail: z.string(),
});
export type TelegramTestResult = z.infer<typeof telegramTestResultSchema>;

export const telegramDestinationSchema = z.object({
  id: z.string(),
  /** Маска вместо токена: `tgram://•••/-1002946167407:8`. */
  masked: z.string(),
  chatId: z.string(),
  topic: z.number().int().nullable(),
  /** @имя бота и название чата — панель узнаёт их у Telegram при сохранении и проверке. */
  botName: z.string().nullable(),
  chatTitle: z.string().nullable(),
  lastTest: telegramTestResultSchema.nullable(),
});
export type TelegramDestination = z.infer<typeof telegramDestinationSchema>;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в виде ЧЧ:ММ');

export const telegramQuietSchema = z.object({
  enabled: z.boolean(),
  from: hhmm,
  to: hhmm,
  /** Часовой пояс браузера владельца (IANA), чтобы «23:00» значило его 23:00, а не время сервера. */
  timeZone: z.string().min(1).max(64),
});
export type TelegramQuiet = z.infer<typeof telegramQuietSchema>;
export const TELEGRAM_QUIET_DEFAULT: TelegramQuiet = {
  enabled: false,
  from: '23:00',
  to: '08:00',
  timeZone: 'Europe/Moscow',
};

export const telegramSettingsSchema = z.object({
  destinations: z.array(telegramDestinationSchema),
  events: z.object(
    Object.fromEntries(TELEGRAM_EVENTS.map((k) => [k, z.boolean()])) as Record<TelegramEvent, z.ZodBoolean>,
  ),
  quiet: telegramQuietSchema,
});
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>;

/**
 * Сохранение: итоговый список назначений. Уже сохранённое — по `id` (токен остаётся на сервере),
 * новое — по `url`. Чего нет в списке, то удаляется.
 */
export const telegramSettingsUpdateSchema = z.object({
  destinations: z
    .array(
      z.union([
        z.object({ id: z.string().min(1) }),
        z.object({
          url: z
            .string()
            .trim()
            .refine((v) => parseTelegramUrl(v) !== null, {
              message: 'Формат: tgram://токен_бота/id_чата или tgram://токен_бота/id_чата:тема',
            }),
        }),
      ]),
    )
    .max(TELEGRAM_DESTINATIONS_MAX, `Не больше ${TELEGRAM_DESTINATIONS_MAX} чатов`)
    .optional(),
  events: z
    .object(
      Object.fromEntries(TELEGRAM_EVENTS.map((k) => [k, z.boolean().optional()])) as Record<
        TelegramEvent,
        z.ZodOptional<z.ZodBoolean>
      >,
    )
    .optional(),
  quiet: telegramQuietSchema.optional(),
});
export type TelegramSettingsUpdate = z.infer<typeof telegramSettingsUpdateSchema>;

/** Тест: сохранённое назначение по `id` или ещё не сохранённая строка по `url` (ровно одно из двух). */
export const telegramTestRequestSchema = z
  .object({
    id: z.string().min(1).optional(),
    url: z
      .string()
      .trim()
      .refine((v) => parseTelegramUrl(v) !== null, { message: 'Формат: tgram://токен_бота/id_чата:тема' })
      .optional(),
  })
  .refine((v) => Boolean(v.id) !== Boolean(v.url), { message: 'Укажите либо сохранённый чат, либо ссылку.' });
export type TelegramTestRequest = z.infer<typeof telegramTestRequestSchema>;

export const telegramTestResponseSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
  botName: z.string().nullable(),
  chatTitle: z.string().nullable(),
});
export type TelegramTestResponse = z.infer<typeof telegramTestResponseSchema>;
