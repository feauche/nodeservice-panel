import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closePreAuth,
  holdPreAuth,
  ownOrReject,
  PREAUTH_CLOSE_GRACE_MS,
  PREAUTH_OWN_WAIT_MS,
  PREAUTH_PER_ADDRESS,
  PREAUTH_TOTAL,
  PreAuthLimiter,
  rejectUpgrade,
  upgradeClientIp,
} from './ws-preauth.js';

describe('PreAuthLimiter: соединения без входа', () => {
  it('с одного адреса — не больше пяти; с другого адреса — свои пять', () => {
    expect(PREAUTH_PER_ADDRESS).toBe(5);
    expect(PREAUTH_TOTAL).toBe(50);
    const lim = new PreAuthLimiter();
    const held = Array.from({ length: 5 }, () => lim.acquire('203.0.113.7'));
    expect(held.every(Boolean)).toBe(true);
    expect(lim.acquire('203.0.113.7')).toBeNull();
    expect(lim.acquire('203.0.113.8')).not.toBeNull();
  });

  it('освобождённое место (вход пройден или соединение закрыто) снова доступно; повторное освобождение ничего не ломает', () => {
    const lim = new PreAuthLimiter();
    const held = Array.from({ length: 5 }, () => lim.acquire('203.0.113.7'));
    held[0]?.();
    held[0]?.();
    expect(lim.acquire('203.0.113.7')).not.toBeNull();
    expect(lim.acquire('203.0.113.7')).toBeNull();
  });

  it('IPv6 считается по сети /64: смена адреса внутри сети предел не обходит', () => {
    const lim = new PreAuthLimiter();
    for (let i = 1; i <= 5; i += 1) expect(lim.acquire(`2001:db8:1:2::${i}`)).not.toBeNull();
    expect(lim.acquire('2001:db8:1:2:ffff::9')).toBeNull();
    expect(lim.acquire('2001:db8:1:3::1')).not.toBeNull();
    // IPv4 в записи IPv6 — тот же адрес.
    for (let i = 0; i < 5; i += 1) lim.acquire('198.51.100.1');
    expect(lim.acquire('::ffff:198.51.100.1')).toBeNull();
  });

  it('всего — не больше пятидесяти, с каких бы адресов ни шли', () => {
    const lim = new PreAuthLimiter();
    for (let i = 0; i < 50; i += 1) expect(lim.acquire(`198.51.100.${i}`)).not.toBeNull();
    expect(lim.acquire('198.51.100.200')).toBeNull();
  });

  it('сверх общего предела (адрес известного сервера) — можно, но с адреса всё равно не больше пяти', () => {
    const lim = new PreAuthLimiter();
    for (let i = 0; i < 50; i += 1) lim.acquire(`198.51.100.${i}`);
    expect(lim.acquire('192.0.2.10')).toBeNull();
    for (let i = 0; i < 5; i += 1) expect(lim.acquire('192.0.2.10', true)).not.toBeNull();
    expect(lim.acquire('192.0.2.10', true)).toBeNull();
  });
});

describe('upgradeClientIp: адрес клиента за прокси', () => {
  const req = (remote: string, xff?: string) =>
    ({
      socket: { remoteAddress: remote },
      headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    }) as unknown as IncomingMessage;

  it('как у Express с trust proxy = число: столько ближайших адресов — доверенные прокси', () => {
    // Caddy дописывает адрес клиента в X-Forwarded-For; подделанное клиентом начало не принимается.
    expect(upgradeClientIp(req('172.18.0.3', '203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(upgradeClientIp(req('172.18.0.3', '1.1.1.1, 203.0.113.7'), 1)).toBe('203.0.113.7');
    expect(upgradeClientIp(req('172.18.0.3', '1.1.1.1, 203.0.113.7'), 2)).toBe('1.1.1.1');
    // Без заголовка или без доверия прокси — адрес сокета.
    expect(upgradeClientIp(req('172.18.0.3'), 1)).toBe('172.18.0.3');
    expect(upgradeClientIp(req('172.18.0.3', '203.0.113.7'), 0)).toBe('172.18.0.3');
    // Цепочка короче числа прокси — самый дальний адрес.
    expect(upgradeClientIp(req('172.18.0.3', '203.0.113.7'), 5)).toBe('203.0.113.7');
    // Не адрес (заголовок подделан в обход Caddy) — адрес сокета: в Журнал идёт только настоящий IP.
    expect(upgradeClientIp(req('172.18.0.3', 'не-адрес'), 1)).toBe('172.18.0.3');
    expect(upgradeClientIp(req('172.18.0.3', '2001:db8::7'), 1)).toBe('2001:db8::7');
  });
});

/** Сокет-заглушка: что панель ему написала и закрыт ли он. */
function socket() {
  const s = new PassThrough();
  const chunks: Buffer[] = [];
  s.on('data', (c: Buffer) => chunks.push(c));
  const closed = new Promise<void>((resolve) => s.once('close', () => resolve()));
  return { s, closed, written: () => Buffer.concat(chunks).toString() };
}

describe('holdPreAuth и rejectUpgrade: лишнее соединение закрывается сразу', () => {
  it('сверх предела — места нет, отказ 429 и разрыв до рукопожатия; в пределе — место до закрытия сокета', async () => {
    const lim = new PreAuthLimiter();
    const sockets = Array.from({ length: 5 }, () => new PassThrough());
    for (const s of sockets) expect(holdPreAuth(lim, '203.0.113.7', s)).not.toBeNull();

    const extra = socket();
    expect(holdPreAuth(lim, '203.0.113.7', extra.s)).toBeNull();
    rejectUpgrade(extra.s);
    await extra.closed;
    expect(extra.written()).toMatch(/^HTTP\/1\.1 429 /);

    // Закрытый сокет освобождает место сам — без явного вызова.
    const first = sockets[0] as PassThrough;
    const gone = new Promise<void>((resolve) => first.once('close', () => resolve()));
    first.destroy();
    await gone;
    expect(holdPreAuth(lim, '203.0.113.7', new PassThrough())).not.toBeNull();
  });

  it('уже закрытый сокет места не занимает: иначе его место не освободилось бы никогда', () => {
    const lim = new PreAuthLimiter(1, 1);
    const gone = new PassThrough();
    gone.destroy();
    expect(holdPreAuth(lim, '203.0.113.7', gone)).toBeNull();
    expect(holdPreAuth(lim, '203.0.113.7', new PassThrough())).not.toBeNull();
  });
});

describe('ownOrReject: прихожая занята — «своего» пускаем, остальным отказ', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('свой — пускаем без отказа; чужой или сбой проверки — 429', async () => {
    const own = socket();
    expect(await ownOrReject(own.s, async () => true)).toBe(true);
    expect(own.written()).toBe('');
    expect(own.s.destroyed).toBe(false);

    for (const check of [async () => false, async () => Promise.reject(new Error('valkey'))]) {
      const other = socket();
      expect(await ownOrReject(other.s, check)).toBe(false);
      await other.closed;
      expect(other.written()).toMatch(/^HTTP\/1\.1 429 /);
    }
  });

  it('проверка не ответила за отведённое время — 429, соединение не висит', async () => {
    vi.useFakeTimers();
    const slow = socket();
    const verdict = ownOrReject(slow.s, () => new Promise<boolean>(() => {}));
    await vi.advanceTimersByTimeAsync(PREAUTH_OWN_WAIT_MS);
    expect(await verdict).toBe(false);
    expect(slow.written()).toMatch(/^HTTP\/1\.1 429 /);
  });

  it('клиент ушёл, пока шла проверка, — ни ответа, ни падения', async () => {
    const gone = socket();
    let answer!: (v: boolean) => void;
    const verdict = ownOrReject(gone.s, () => new Promise<boolean>((r) => (answer = r)));
    gone.s.emit('error', new Error('ECONNRESET'));
    await gone.closed;
    answer(true);
    expect(await verdict).toBe(false);
  });
});

describe('closePreAuth: отказ до входа не держит соединение', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('кадр закрытия с причиной; клиент не ответил на закрытие — через секунду разрыв', () => {
    vi.useFakeTimers();
    const ws = { close: vi.fn(), terminate: vi.fn() };
    closePreAuth(ws as never, 4401, 'auth timeout');
    expect(ws.close).toHaveBeenCalledWith(4401, 'auth timeout');
    vi.advanceTimersByTime(PREAUTH_CLOSE_GRACE_MS - 1);
    expect(ws.terminate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });
});
