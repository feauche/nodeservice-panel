import { z } from 'zod';

import { INCIDENT_KINDS, type IncidentKind } from './incidents.js';

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
  'autofix_started',
  'fix_failed',
  'reminder',
  'maintenance',
  'check_failed',
  'jarvis_card',
  'login',
  'billing_soon',
  'billing_overdue',
] as const;
export const telegramEventSchema = z.enum(TELEGRAM_EVENTS);
export type TelegramEvent = z.infer<typeof telegramEventSchema>;

export const TELEGRAM_EVENT_LABELS: Record<TelegramEvent, string> = {
  incident_crit: 'Критичный инцидент',
  incident_warn: 'Предупреждение',
  needs_confirm: 'Нужно ваше «Да»',
  resolved: 'Починилось',
  autofix_started: 'Автопочинка начала чинить',
  fix_failed: 'Шаг починки не помог',
  reminder: 'Напоминание о нерешённом',
  maintenance: 'Обслуживание',
  check_failed: 'Проверка сервера нашла ошибку',
  jarvis_card: 'Карточка Джарвиса ждёт решения',
  login: 'Вход в панель с нового устройства',
  billing_soon: 'Скоро оплата',
  billing_overdue: 'Оплата просрочена',
};
export const TELEGRAM_EVENT_HINTS: Record<TelegramEvent, string> = {
  incident_crit: 'Сервер или агент недоступен, нода упала, похоже на блокировку.',
  incident_warn: 'Высокая нагрузка, диск заполняется, онлайн упал без подтверждённой блокировки.',
  needs_confirm: 'Автопочинка предлагает шаг и ждёт подтверждения — или нужно вмешаться вручную.',
  resolved: 'Инцидент закрыт — сам или после шага. Приходит ответом на исходное сообщение.',
  autofix_started: '«Чиню автоматически»: какой шаг панель запустила сама.',
  fix_failed: 'Что пробовали и что предлагаем дальше.',
  reminder: 'Критичный инцидент всё ещё открыт — напоминание ответом на исходное сообщение.',
  maintenance: 'Есть обновления безопасности, нужна перезагрузка, агент устарел. Раз в сутки, не чаще.',
  jarvis_card: 'Джарвис предложил изменение или тяжёлую проверку.',
  check_failed: 'Лёгкая проверка (геоблок, DPI и другие) упала или не уложилась во время.',
  login: 'И серия неудачных попыток входа.',
  billing_soon:
    'Без звука, за столько дней до срока, сколько указано в карточке (по умолчанию за 3 дня). Один раз на срок.',
  billing_overdue:
    'Со звуком, в день срока и раз в сутки, пока не продлите. Если сервер из этой оплаты недоступен — скажем об этом.',
};
/** Метка важности рядом с названием (как в витрине K1); null — без метки. */
export const TELEGRAM_EVENT_TONE: Record<TelegramEvent, 'crit' | 'warn' | 'ok' | null> = {
  incident_crit: 'crit',
  incident_warn: 'warn',
  needs_confirm: null,
  resolved: 'ok',
  autofix_started: null,
  fix_failed: null,
  reminder: null,
  maintenance: null,
  check_failed: null,
  jarvis_card: null,
  login: null,
  billing_soon: 'warn',
  billing_overdue: 'crit',
};
export const TELEGRAM_EVENT_GROUPS: ReadonlyArray<{ title: string; keys: readonly TelegramEvent[] }> = [
  {
    title: 'Инциденты',
    keys: ['incident_crit', 'incident_warn', 'needs_confirm', 'resolved', 'autofix_started', 'fix_failed'],
  },
  { title: 'Серверы и Джарвис', keys: ['maintenance', 'check_failed', 'jarvis_card'] },
  { title: 'Биллинг', keys: ['billing_soon', 'billing_overdue'] },
  { title: 'Безопасность', keys: ['login'] },
];

export type TelegramEvents = Record<TelegramEvent, boolean>;
export const TELEGRAM_EVENTS_DEFAULT: TelegramEvents = {
  incident_crit: true,
  incident_warn: true,
  needs_confirm: true,
  resolved: true,
  autofix_started: false,
  fix_failed: true,
  reminder: true,
  maintenance: false,
  check_failed: false,
  jarvis_card: false,
  login: true,
  billing_soon: true,
  billing_overdue: true,
};

/** Виды инцидентов по группам для тумблеров «Какие инциденты» (витрина `telegram-messages-variants.html`, 2A). */
export const TELEGRAM_KIND_GROUPS: ReadonlyArray<{ title: string; keys: readonly IncidentKind[] }> = [
  { title: 'Связь', keys: ['agent_offline', 'ssh_down'] },
  { title: 'Нода', keys: ['node_down', 'node_blocked'] },
  { title: 'Ресурсы', keys: ['cpu_high', 'mem_high', 'disk_high'] },
];
export const TELEGRAM_KIND_LABELS: Record<IncidentKind, string> = {
  agent_offline: 'Агент не в сети',
  ssh_down: 'SSH недоступен',
  node_down: 'Контейнер ноды не запущен',
  node_blocked: 'Резкое падение онлайна и блокировки',
  cpu_high: 'Нагрузка на процессор',
  mem_high: 'Память на пределе',
  disk_high: 'Диск заполняется',
};
export const TELEGRAM_KIND_HINTS: Record<IncidentKind, string> = {
  agent_offline: 'Агент перестал присылать сигнал. Часто вместе с «SSH недоступен», если сервер лёг целиком.',
  ssh_down: 'Панель не может зайти на сервер по SSH.',
  node_down: 'Сервер жив, но нода остановлена.',
  node_blocked:
    'Онлайн ноды упал на 80 % и больше: блокировка ТСПУ, «16–20 КБ», IP из России или сервер недоступен.',
  cpu_high: 'Загрузка держится выше порога дольше времени реакции.',
  mem_high: 'Занятость памяти держится выше порога.',
  disk_high: 'Заполнение диска держится выше порога.',
};
export type TelegramKinds = Record<IncidentKind, boolean>;
export const TELEGRAM_KINDS_DEFAULT: TelegramKinds = Object.fromEntries(
  INCIDENT_KINDS.map((k) => [k, true]),
) as TelegramKinds;

/** Через сколько часов напоминать о нерешённом критичном. */
export const TELEGRAM_REMIND_HOURS = [1, 2, 4, 8, 12, 24] as const;
export const telegramDeliverySchema = z.object({
  /** Второй сбой того же сервера за 10 минут — ответом на первое сообщение и без звука. */
  groupPerServer: z.boolean(),
  /** Звук только у критичных, «ждёт "Да"», входа и напоминаний; остальное приходит тихо. */
  silentWarnings: z.boolean(),
  /** Напоминать о нерешённом критичном каждые N часов (событие `reminder`). */
  remindHours: z
    .number()
    .int()
    .refine((v) => (TELEGRAM_REMIND_HOURS as readonly number[]).includes(v), {
      message: 'Часы из списка',
    }),
});
export type TelegramDelivery = z.infer<typeof telegramDeliverySchema>;
export const TELEGRAM_DELIVERY_DEFAULT: TelegramDelivery = {
  groupPerServer: true,
  silentWarnings: true,
  remindHours: 2,
};

/**
 * Прокси для Telegram (необязательно): `socks5://логин:пароль@1.2.3.4:1080` или `http://1.2.3.4:3128`.
 * Нужен, если сервер панели в России и Telegram с него недоступен.
 */
export const TELEGRAM_PROXY_RE =
  /^(socks5h?|http|https):\/\/(?:[^\s:@/]+(?::[^\s@/]*)?@)?[A-Za-z0-9.-]+:\d{1,5}\/?$/;
/** Верный прокси — и не маска `***` (пароль из маски отправить нельзя: его нужно ввести заново). */
export function isValidTelegramProxy(v: string): boolean {
  return TELEGRAM_PROXY_RE.test(v) && !v.includes('***');
}
export function maskTelegramProxy(url: string): string {
  return url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
}

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
  kinds: z.object(
    Object.fromEntries(INCIDENT_KINDS.map((k) => [k, z.boolean()])) as Record<IncidentKind, z.ZodBoolean>,
  ),
  delivery: telegramDeliverySchema,
  /** Прокси маской (пароль скрыт); null — отправка напрямую. */
  proxy: z.string().nullable(),
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
  kinds: z
    .object(
      Object.fromEntries(INCIDENT_KINDS.map((k) => [k, z.boolean().optional()])) as Record<
        IncidentKind,
        z.ZodOptional<z.ZodBoolean>
      >,
    )
    .optional(),
  delivery: telegramDeliverySchema.optional(),
  /** Не передан — оставить как есть; null или пусто — убрать; строка — новый прокси. */
  proxy: z
    .string()
    .trim()

    .refine((v) => v === '' || isValidTelegramProxy(v), {
      message: 'Формат: socks5://логин:пароль@адрес:порт или http://адрес:порт',
    })
    .nullable()
    .optional(),
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
  .extend({
    /** Проверить с ещё не сохранённым прокси (как в поле сейчас); пусто — без прокси. */
    proxy: z
      .string()
      .trim()

      .refine((v) => v === '' || isValidTelegramProxy(v), { message: 'Неверный формат прокси' })
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
