import { z } from 'zod';

/**
 * Веб-терминал (этап 7). Открытие — за step-up: сначала POST /api/servers/:id/terminal,
 * затем WebSocket /ws/terminal?server=<id>&cols=&rows=. Один сокет = одна PTY-сессия.
 * Содержимое сессии не пишется в Журнал — только факт открытия/закрытия.
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
