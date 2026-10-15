import { z } from 'zod';

/**
 * Сигнал «панель жива» внешнему сервису проверки (Healthchecks.io, Uptime Kuma «Push», Better Stack heartbeat).
 * Пока панель работает и следит за нодами, она раз в минуту открывает адрес сервиса; перестала (сервер
 * упал, база легла, поиск событий встал) — сервис не дождётся сигнала и сам пришлёт тревогу.
 *
 *  GET  /api/settings/heartbeat       → HeartbeatView
 *  PUT  /api/settings/heartbeat       { url } → HeartbeatView     ('' — выключить)
 *  POST /api/settings/heartbeat/test  { url? } → HeartbeatTestResponse (один сигнал сейчас)
 */

/** Как часто панель шлёт сигнал. На стороне сервиса — «период 1 минута», запас — 3–5 минут. */
export const HEARTBEAT_EVERY_SECONDS = 60;
/** Сколько ждать ответа сервиса. */
export const HEARTBEAT_TIMEOUT_SECONDS = 10;
export const HEARTBEAT_URL_MAX = 500;

export const HEARTBEAT_PROBLEM = {
  /** Проверочный сигнал чаще раза в 5 секунд. */
  tooOften: 'urn:nodeservice:problem:heartbeat-too-often',
  /** Адрес ведёт во внутреннюю сеть (localhost, 10.x, 192.168.x…). */
  privateAddress: 'urn:nodeservice:problem:heartbeat-private-address',
  /** Проверить нечего: адрес не передан и не сохранён. */
  noUrl: 'urn:nodeservice:problem:heartbeat-no-url',
} as const;

/** Адрес сервиса: '' — сигнал выключен; иначе http(s) без логина и пароля, до 500 символов. */
export const heartbeatUrlSchema = z
  .string()
  .trim()
  .max(HEARTBEAT_URL_MAX, `Не длиннее ${HEARTBEAT_URL_MAX} символов`)
  .superRefine((value, ctx) => {
    if (value === '') return;
    // Без глобального URL: пакет общий для браузера и сервера и собирается без их типов.
    if (!/^[a-z][a-z\d+.-]*:/i.test(value) || (/^https?:/i.test(value) && !z.url().safeParse(value).success))
      ctx.addIssue({ code: 'custom', message: 'Введите адрес вида https://hc-ping.com/…' });
    else if (!/^https?:\/\/[^/?#]/i.test(value))
      ctx.addIssue({ code: 'custom', message: 'Адрес должен начинаться с https:// или http://' });
    else if (/^https?:\/\/[^/?#]*@/i.test(value))
      ctx.addIssue({
        code: 'custom',
        message: 'Адрес с логином и паролем не подходит — нужна ссылка сервиса',
      });
  });

export const heartbeatSettingsSchema = z.object({ url: heartbeatUrlSchema });
export type HeartbeatSettings = z.infer<typeof heartbeatSettingsSchema>;
export const HEARTBEAT_DEFAULTS: HeartbeatSettings = { url: '' };

/** Одна попытка сигнала. */
export const heartbeatResultSchema = z.object({
  /** Сервис принял сигнал (ответил 2xx). */
  ok: z.boolean(),
  /** Запрос ушёл. false — панель сама не готова и сигнал намеренно не отправлен. */
  sent: z.boolean(),
  at: z.iso.datetime(),
  /** Код ответа сервиса; null — ответа не было или сигнал не отправлялся. */
  httpStatus: z.number().int().nullable(),
  /** Сколько ждали ответа, мс; null — сигнал не отправлялся. */
  ms: z.number().int().nullable(),
  /** Что не так — по-русски: «сервис ответил 404», «нет ответа за 10 с», «не отправлен: …». */
  problem: z.string().nullable(),
});
export type HeartbeatResult = z.infer<typeof heartbeatResultSchema>;

/** Сколько помним попыток для полосы «последний час» в настройках. */
export const HEARTBEAT_RECENT_MINUTES = 60;

/**
 * Попытка для полосы «последний час»: ok — сервис принял; held — панель не готова, сигнал придержан;
 * failed — сервис не принял или не ответил.
 */
export const heartbeatAttemptSchema = z.object({
  at: z.iso.datetime(),
  outcome: z.enum(['ok', 'held', 'failed']),
});
export type HeartbeatAttempt = z.infer<typeof heartbeatAttemptSchema>;

/** Что было с сигналом с запуска панели (в памяти: после перезапуска — пусто до первой попытки). */
export const heartbeatStatusSchema = z.object({
  everySeconds: z.number().int(),
  lastAttemptAt: z.iso.datetime().nullable(),
  lastOkAt: z.iso.datetime().nullable(),
  lastResult: heartbeatResultSchema.nullable(),
  /** Попыток подряд без принятого сигнала (неудачи и «не отправлен»). */
  consecutiveFailures: z.number().int(),
  /** Попытки за последний час, старые — первыми. Минута без попытки — панель не работала или сигнал был выключен. */
  recent: z.array(heartbeatAttemptSchema),
});
export type HeartbeatStatus = z.infer<typeof heartbeatStatusSchema>;

export const heartbeatViewSchema = z.object({ url: z.string(), status: heartbeatStatusSchema });
export type HeartbeatView = z.infer<typeof heartbeatViewSchema>;

/** Проверка: на переданный адрес (ещё не сохранённый) или, без него, на сохранённый. */
export const heartbeatTestRequestSchema = z.object({ url: heartbeatUrlSchema.optional() });
export type HeartbeatTestRequest = z.infer<typeof heartbeatTestRequestSchema>;

export const heartbeatTestResponseSchema = z.object({
  ok: z.boolean(),
  httpStatus: z.number().int().nullable(),
  ms: z.number().int(),
  problem: z.string().nullable(),
  /** Панель сама готова. false — проверочный сигнал всё равно ушёл, но обычный сейчас не отправлялся бы. */
  ready: z.boolean(),
  /** Почему не готова — по-русски; пусто, если готова. */
  notReady: z.array(z.string()),
});
export type HeartbeatTestResponse = z.infer<typeof heartbeatTestResponseSchema>;
