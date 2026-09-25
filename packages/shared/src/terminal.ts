import { z } from 'zod';

/**
 * Веб-терминал (этап 7). Открытие — за step-up: сначала POST /api/servers/:id/terminal,
 * затем WebSocket /ws/terminal?server=<id>&cols=&rows=. Один сокет = одна PTY-сессия.
 * В Журнал пишется только факт открытия/закрытия; вывод сессии (то, что видел оператор)
 * сохраняется отдельно в историю терминала — для просмотра и для контекста Джарвиса.
 */
export const TERMINAL_WS_PATH = '/ws/terminal';
export const TERMINAL_IDLE_MS = 15 * 60_000;
export const TERMINAL_MAX_SESSIONS = 4;

/** Типы сообщений (короткие ключи — трафик терминала бывает плотным). */
export const TERMINAL_MSG = {
  input: 'i',
  resize: 'r',
  output: 'o',
  ready: 'y',
  exit: 'x',
  error: 'e',
} as const;

/** Клиент → сервер. */
export const terminalClientMsgSchema = z.union([
  z.object({ t: z.literal('i'), d: z.string() }),
  z.object({ t: z.literal('r'), c: z.number().int().min(1).max(1000), r: z.number().int().min(1).max(1000) }),
]);
export type TerminalClientMsg = z.infer<typeof terminalClientMsgSchema>;

/** Сервер → клиент. */
export type TerminalServerMsg =
  | { t: 'y' }
  | { t: 'o'; d: string }
  | { t: 'x'; code: number | null }
  | { t: 'e'; m: string };

export const terminalOpenResponseSchema = z.object({ url: z.string() });
export type TerminalOpenResponse = z.infer<typeof terminalOpenResponseSchema>;

/* ---------- история сессий ---------- */
/** Сколько вывода хранить на сессию (символов); дальше запись помечается усечённой. */
export const TERMINAL_TRANSCRIPT_MAX = 2_000_000;
/** Сколько дней хранить историю сессий. */
export const TERMINAL_HISTORY_DAYS = 30;
export const TERMINAL_HISTORY_LIMIT = 100;
/** Максимальная длина строки поиска по истории (символов). */
export const TERMINAL_SEARCH_MAX = 200;

/** Период истории для списка и поиска: сегодня, 7 дней или всё, что хранится (30 дней). */
export const TERMINAL_PERIODS = ['all', 'today', '7d'] as const;
export type TerminalPeriod = (typeof TERMINAL_PERIODS)[number];

export const terminalSessionSchema = z.object({
  id: z.uuid(),
  serverId: z.uuid(),
  actorDisplay: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }),
  endedAt: z.iso.datetime({ offset: true }).nullable(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** Сколько байт вывода прошло через сессию (считается и после усечения записи). */
  bytesOut: z.number().int().min(0),
  truncated: z.boolean(),
  exitCode: z.number().int().nullable(),
  endReason: z.string().nullable(),
  /**
   * Сколько раз строка поиска встречается в записи (без регистра, по тексту без ANSI-кодов).
   * Есть только в ответе на запрос с `q`; сессии без совпадений в такой ответ не попадают.
   */
  matches: z.number().int().min(0).optional(),
});
export type TerminalSessionInfo = z.infer<typeof terminalSessionSchema>;

export const terminalSessionsResponseSchema = z.object({ items: z.array(terminalSessionSchema) });
export type TerminalSessionsResponse = z.infer<typeof terminalSessionsResponseSchema>;

/**
 * Сессия с записью вывода (ANSI-последовательности сохранены, клиент убирает их при показе).
 * `transcript` — кусок начиная с `offset` (символы), `length` — полная длина записи: живую сессию
 * клиент догружает по смещению, а не перекачивает целиком.
 */
export const terminalSessionDetailSchema = terminalSessionSchema.extend({
  transcript: z.string(),
  offset: z.number().int().min(0),
  length: z.number().int().min(0),
});
export type TerminalSessionDetail = z.infer<typeof terminalSessionDetailSchema>;
