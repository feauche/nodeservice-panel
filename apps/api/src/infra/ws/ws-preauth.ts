import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

import { throttleIp } from '../../modules/auth/throttle.schedule.js';

/**
 * Соединения шлюзов WebSocket, ещё не прошедшие вход. Шлюзы открыты всему интернету: без предела любой
 * мог держать тысячи соединений до таймаута входа, и каждое тратит память и проверки панели. С одного
 * адреса (IPv6 — с сети /64, как в паузах входа) — не больше PREAUTH_PER_ADDRESS, всего — PREAUTH_TOTAL;
 * лишние закрываются сразу, до рукопожатия. Прошедшее вход соединение место освобождает и в счёт не идёт.
 */
export const PREAUTH_PER_ADDRESS = 5;
export const PREAUTH_TOTAL = 50;
/**
 * Сколько ждём проверку «своего», когда прихожая занята (сессия владельца, адрес сервера парка): дольше —
 * отказ, чтобы и такие соединения не висели.
 */
export const PREAUTH_OWN_WAIT_MS = 3_000;
/**
 * Сколько отказанное до входа соединение ждёт ответа на кадр закрытия. Библиотека ws ждёт его 30 с: клиент,
 * который молчит, всё это время держал бы место в прихожей.
 */
export const PREAUTH_CLOSE_GRACE_MS = 1_000;

export class PreAuthLimiter {
  private readonly byAddress = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly perAddress = PREAUTH_PER_ADDRESS,
    private readonly totalMax = PREAUTH_TOTAL,
  ) {}

  /**
   * Занять место. null — предел исчерпан; иначе функция, которая место освобождает (повторно — ничего).
   * overTotal — сверх общего предела (адрес сервера парка), но предел с адреса действует и тогда.
   */
  acquire(ip: string, overTotal = false): (() => void) | null {
    const key = throttleIp(ip);
    const held = this.byAddress.get(key) ?? 0;
    if (held >= this.perAddress || (!overTotal && this.total >= this.totalMax)) return null;
    this.byAddress.set(key, held + 1);
    this.total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total -= 1;
      const left = (this.byAddress.get(key) ?? 1) - 1;
      if (left > 0) this.byAddress.set(key, left);
      else this.byAddress.delete(key);
    };
  }
}

/**
 * Адрес клиента у запроса на WebSocket — так же, как Express считает req.ip при `trust proxy` = числу:
 * столько ближайших адресов цепочки (сокет, затем X-Forwarded-For справа налево) — доверенные прокси
 * (Caddy). Начало X-Forwarded-For присылает сам клиент, ему не верим. Не адрес (заголовок подделан в обход
 * Caddy) — берём адрес сокета: значение уходит в Журнал, где колонка принимает только IP.
 */
export function upgradeClientIp(req: IncomingMessage, trustHops: number): string {
  const socketIp = req.socket.remoteAddress ?? '';
  if (trustHops <= 0) return socketIp;
  const header = req.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : (header ?? ''))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .reverse();
  const chain = [socketIp, ...forwarded];
  const ip = chain[Math.min(trustHops, chain.length - 1)] ?? socketIp;
  return isIP(ip) ? ip : socketIp;
}

/** Отказ до рукопожатия: 429 и разрыв — WebSocket не открывается, памяти на него не тратится. */
export function rejectUpgrade(socket: Duplex): void {
  // Клиент мог уже оборвать связь: ошибка записи без слушателя уронила бы процесс.
  socket.on('error', () => socket.destroy());
  socket.once('finish', () => socket.destroy());
  socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

/**
 * Место в «прихожей» шлюза: занято до входа (вызов возвращённой функции) или до закрытия сокета. null —
 * места нет (отказ — за вызывающим) или сокет уже закрыт: его место не освободилось бы никогда.
 */
export function holdPreAuth(
  limiter: PreAuthLimiter,
  ip: string,
  socket: Duplex,
  overTotal = false,
): (() => void) | null {
  if (socket.destroyed) return null;
  const release = limiter.acquire(ip, overTotal);
  if (release) socket.once('close', release);
  return release;
}

/**
 * Прихожая занята, но соединение может оказаться «своим» (владелец с действующей сессией, агент сервера
 * парка): таких пускаем и так — иначе поток соединений без входа с нескольких адресов закрывал бы им шлюз.
 * Проверку ждём не дольше PREAUTH_OWN_WAIT_MS. true — пускать; иначе клиент уже получил отказ 429 (или ушёл).
 */
export async function ownOrReject(socket: Duplex, check: () => Promise<boolean>): Promise<boolean> {
  // Пока идёт проверка, клиент может оборвать связь: ошибка сокета без слушателя уронила бы панель.
  socket.on('error', () => socket.destroy());
  let timer: NodeJS.Timeout | undefined;
  const own = await Promise.race([
    check().catch(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), PREAUTH_OWN_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (socket.destroyed) return false;
  if (!own) rejectUpgrade(socket);
  return own;
}

/**
 * Отказ соединению, не прошедшему вход: кадр закрытия с причиной, а если клиент на него не ответил за
 * PREAUTH_CLOSE_GRACE_MS — разрыв. Место в прихожей освобождается вместе с сокетом.
 */
export function closePreAuth(ws: WebSocket, code: number, reason: string): void {
  ws.close(code, reason);
  setTimeout(() => ws.terminate(), PREAUTH_CLOSE_GRACE_MS).unref();
}
