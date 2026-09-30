import { HttpException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { deleteByPattern, testValkey } from './test-valkey.js';
import { blockSecondsForSeries } from './throttle.schedule.js';
import {
  deviceScope,
  NOTIFY_FLOOR_SECONDS,
  NOTIFY_PAIR_COOLDOWN_SECONDS,
  NOTIFY_UNKNOWN_FLOOR_SECONDS,
  SECOND_FACTOR_LIMIT,
  SECOND_FACTOR_WINDOW_SECONDS,
  SERIES_MEMORY_SECONDS,
  sessionScope,
  ThrottleService,
} from './throttle.service.js';

describe('ThrottleService (Valkey)', () => {
  let valkey: Redis;
  let svc: ThrottleService;
  const key = { ip: '203.0.113.7', login: 'Throttle-Test' };

  beforeAll(async () => {
    valkey = testValkey();
    svc = new ThrottleService(valkey);
    await deleteByPattern(valkey, 'throttle:*');
  });
  afterAll(async () => {
    await deleteByPattern(valkey, 'throttle:*');
    await valkey.quit();
  });

  it('4 неудачи — свободно, 5-я включает паузу 30 с, потом 429 с retryAfterSeconds', async () => {
    await svc.reset(key);
    for (let i = 0; i < 4; i++) {
      await svc.recordFailure(key);
      await svc.assertAllowed(key);
    }
    const err = await svc.recordFailure(key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpException);
    const body = (err as HttpException).getResponse() as { extensions: { retryAfterSeconds: number } };
    expect((err as HttpException).getStatus()).toBe(429);
    expect(body.extensions.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(body.extensions.retryAfterSeconds).toBeGreaterThan(25);

    await expect(svc.assertAllowed(key)).rejects.toBeInstanceOf(HttpException);
    // логин — регистронезависимый, IP — отдельный ключ
    await expect(svc.assertAllowed({ ip: '198.51.100.1', login: 'throttle-test' })).rejects.toThrow();
    await expect(svc.assertAllowed({ ip: '198.51.100.1', login: 'someone-else' })).resolves.toBeUndefined();
    expect(await svc.currentSeries('login', key.login)).toBe(1);
    // память о серии — час (не сутки): после часа тишины расписание начинается с 30 с
    expect(SERIES_MEMORY_SECONDS).toBe(3600);
    const ttl = await valkey.ttl('throttle:series:login:throttle-test');
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('успех сбрасывает счётчики и серии', async () => {
    await svc.reset(key);
    await expect(svc.assertAllowed(key)).resolves.toBeUndefined();
    expect(await svc.currentSeries('ip', key.ip)).toBe(0);
  });
});

describe('ThrottleService: попытка занимается до проверки (Valkey)', () => {
  let valkey: Redis;
  let svc: ThrottleService;
  let n = 0;
  /** Свой адрес и логин на каждый тест: состояние соседних тестов не мешает. */
  const fresh = () => {
    n += 1;
    const tag = `${Date.now().toString(36)}${n}`;
    return { ip: `198.18.${(n * 7) % 250}.${n % 250}`, login: `res-${tag}` };
  };
  /** «Прошло время»: пауза кончилась, память о сериях осталась. */
  const endPauses = () => deleteByPattern(valkey, 'throttle:block:*');

  beforeAll(async () => {
    valkey = testValkey();
    svc = new ThrottleService(valkey);
    await deleteByPattern(valkey, 'throttle:*');
  });
  afterAll(async () => {
    await deleteByPattern(valkey, 'throttle:*');
    await valkey.quit();
  });

  it('залп параллельных запросов: занять удаётся не больше пяти попыток, паузы при этом нет', async () => {
    const key = fresh();
    const all = await Promise.all(Array.from({ length: 12 }, () => svc.reserve(key)));
    expect(all.filter((r) => r.allowed)).toHaveLength(5);
    expect(all.filter((r) => !r.allowed && r.reason === 'busy')).toHaveLength(7);
    // одновременность — не серия неудач: пауза не включается и номер серии не растёт
    await expect(svc.assertAllowed(key)).resolves.toBeUndefined();
    expect(await svc.currentSeries('ip', key.ip)).toBe(0);
    // занятые попытки вернулись — снова можно
    await Promise.all(Array.from({ length: 5 }, () => svc.release(key)));
    expect((await svc.reserve(key)).allowed).toBe(true);
  });

  it('пять неудач разом включают паузу один раз: серия №1, 30 с', async () => {
    const key = fresh();
    for (let i = 0; i < 5; i++) expect((await svc.reserve(key)).allowed).toBe(true);
    const outcomes = await Promise.all(Array.from({ length: 5 }, () => svc.fail(key)));
    const started = outcomes.filter((o) => o.started.length > 0);
    expect(started).toHaveLength(1);
    expect(started[0]?.started.map((s) => s.scope.kind).sort()).toEqual(['ip', 'login']);
    expect(started[0]?.started.every((s) => s.seconds === 30 && s.series === 1)).toBe(true);
    expect(started[0]?.retryAfterSeconds).toBe(30);
    expect(await svc.currentSeries('ip', key.ip)).toBe(1);
    expect(await svc.currentSeries('login', key.login)).toBe(1);
  });

  it('во время паузы попытку занять нельзя; отказы считаются и забираются одной цифрой', async () => {
    const key = fresh();
    for (let i = 0; i < 5; i++) {
      await svc.reserve(key);
      await svc.fail(key);
    }
    const first = await svc.reserve(key);
    expect(first).toMatchObject({ allowed: false, reason: 'paused', rejected: 1 });
    if (first.allowed || first.reason !== 'paused') throw new Error('ожидалась пауза');
    expect(first.retryAfterSeconds).toBeGreaterThan(25);
    expect(first.retryAfterSeconds).toBeLessThanOrEqual(30);
    // отказ относится к логину, если он на паузе: «по этому логину отклонено столько-то»
    expect(first.scope).toEqual({ kind: 'login', value: key.login });
    expect(first.scopeSeconds).toBe(first.retryAfterSeconds);
    await svc.reserve(key);
    expect(await svc.reserve(key)).toMatchObject({ allowed: false, rejected: 3 });
    expect(await svc.takeRejected(first.scope)).toBe(3);
    expect(await svc.takeRejected(first.scope)).toBe(0);
  });

  it('верная проверка возвращает попытку, но счёт неудач не обнуляет', async () => {
    const key = fresh();
    for (let i = 0; i < 4; i++) {
      await svc.reserve(key);
      expect((await svc.fail(key)).retryAfterSeconds).toBe(0);
    }
    // пятая попытка — верный пароль (ждём код): попытка возвращена, четыре неудачи остались
    expect((await svc.reserve(key)).allowed).toBe(true);
    await svc.release(key);
    expect((await svc.reserve(key)).allowed).toBe(true);
    const fifth = await svc.fail(key);
    expect(fifth.started).toHaveLength(2);
    expect(fifth.retryAfterSeconds).toBe(30);
  });

  it('возврат попытки не снимает паузу и не стирает чужие неудачи', async () => {
    const key = fresh();
    expect((await svc.reserve(key)).allowed).toBe(true); // запрос «в полёте»
    for (let i = 0; i < 4; i++) await svc.recordFailure(key);
    await expect(svc.recordFailure(key)).rejects.toBeInstanceOf(HttpException);
    // запрос в полёте завершился успехом уже во время паузы — пауза остаётся
    await svc.release(key);
    await expect(svc.assertAllowed(key)).rejects.toBeInstanceOf(HttpException);

    const other = fresh();
    for (let i = 0; i < 3; i++) await svc.recordFailure(other);
    for (let i = 0; i < 10; i++) await svc.release(other); // лишние возвраты
    await svc.recordFailure(other);
    await expect(svc.recordFailure(other)).rejects.toBeInstanceOf(HttpException); // ровно на пятой
  });

  it('неудачи, пришедшие уже во время паузы, в следующую серию не идут: после паузы снова пять попыток', async () => {
    const key = fresh();
    for (let i = 0; i < 4; i++) await svc.recordFailure(key);
    await expect(svc.recordFailure(key)).rejects.toBeInstanceOf(HttpException);
    // залп, успевший пройти проверку до паузы, досчитывается уже при ней
    for (let i = 0; i < 7; i++) await svc.recordFailure(key).catch(() => undefined);
    expect(await svc.currentSeries('login', key.login)).toBe(1);
    await endPauses();
    // иначе все попытки были бы «заняты» до конца окна, а паузы при этом не было бы
    const next = await Promise.all(Array.from({ length: 6 }, () => svc.reserve(key)));
    expect(next.filter((r) => r.allowed)).toHaveLength(5);
  });

  it('серии растут по расписанию 30 → 60 с; полный вход сбрасывает паузу и серию', async () => {
    const key = fresh();
    const series = async () => {
      let last = await svc.fail(key);
      for (let i = 0; i < 4; i++) last = await svc.fail(key);
      return last;
    };
    expect((await series()).retryAfterSeconds).toBe(30);
    await endPauses();
    const second = await series();
    expect(second.retryAfterSeconds).toBe(60);
    expect(second.started.every((s) => s.series === 2)).toBe(true);
    await svc.reset(key);
    await expect(svc.assertAllowed(key)).resolves.toBeUndefined();
    expect(await svc.currentSeries('login', key.login)).toBe(0);
    expect((await series()).retryAfterSeconds).toBe(30);

    // всё расписание — то же, что в чистой функции: 30, 60, 300, 900 и дальше плато
    const other = fresh();
    for (let n = 1; n <= 6; n++) {
      let last = await svc.fail(other);
      for (let i = 0; i < 4; i++) last = await svc.fail(other);
      expect(last.retryAfterSeconds).toBe(blockSecondsForSeries(n));
      expect(await valkey.ttl(`throttle:block:login:${other.login}`)).toBeLessThanOrEqual(
        blockSecondsForSeries(n),
      );
      await endPauses();
    }
    // память о серии живёт не меньше самой паузы
    expect(await valkey.ttl(`throttle:series:login:${other.login}`)).toBeGreaterThan(3500);
  });

  it('IPv6: адреса одной сети /64 делят счёт и паузу, соседняя сеть — нет', async () => {
    const tag = fresh().login;
    const net = `2001:db8:${(n + 16).toString(16)}:1`;
    for (let i = 1; i <= 4; i++)
      await svc.recordFailure({ ip: `${net}:aaaa:bbbb:cccc:${i.toString(16)}`, login: `${tag}-${i}` });
    await expect(svc.recordFailure({ ip: `${net}::5`, login: `${tag}-5` })).rejects.toBeInstanceOf(
      HttpException,
    );
    const sameNet = await svc.reserve({ ip: `${net}:1:2:3:4`, login: `${tag}-6` });
    expect(sameNet).toMatchObject({ allowed: false, reason: 'paused', scope: { kind: 'ip' } });

    // Адрес на долгой паузе, логин — на короткой: сводка отказов по логину ждёт конца его паузы, не адреса.
    const mixed = { ip: `${net}::77`, login: `${tag}-short` };
    await valkey.set(`throttle:block:ip:${net}::/64`, '4', 'EX', 900);
    await valkey.set(`throttle:block:login:${mixed.login}`, '1', 'EX', 30);
    const both = await svc.reserve(mixed);
    expect(both).toMatchObject({
      allowed: false,
      reason: 'paused',
      scope: { kind: 'login' },
      scopeSeconds: 30,
    });
    if (both.allowed || both.reason !== 'paused') throw new Error('ожидалась пауза');
    expect(both.retryAfterSeconds).toBeGreaterThan(890);
    await valkey.del(`throttle:block:ip:${net}::/64`, `throttle:block:login:${mixed.login}`);
    await valkey.set(`throttle:block:ip:${net}::/64`, '1', 'EX', 30);
    expect(
      (await svc.reserve({ ip: `2001:db8:${(n + 16).toString(16)}:2::1`, login: `${tag}-7` })).allowed,
    ).toBe(true);
    expect(await svc.currentSeries('ip', `${net}::99`)).toBe(1);
  });

  it('запомненное устройство и открытая сессия не ждут паузу по логину, но свою паузу получают', async () => {
    const stranger = fresh();
    const login = stranger.login;
    for (let i = 0; i < 4; i++) await svc.recordFailure(stranger);
    await expect(svc.recordFailure(stranger)).rejects.toBeInstanceOf(HttpException);

    const home = fresh().ip;
    // новое устройство с верным паролем по-прежнему ждёт паузу по логину
    expect(await svc.reserve({ ip: home, login })).toMatchObject({ allowed: false, reason: 'paused' });
    // запомненное устройство — нет
    const device = { ip: home, login, known: deviceScope('7f1c0b2e-0000-4000-8000-000000000001') };
    expect((await svc.reserve(device)).allowed).toBe(true);
    await svc.release(device);
    await expect(svc.assertAllowed(device)).resolves.toBeUndefined();

    // но подбор с самого устройства сдерживается так же: пять неудач — пауза для него
    for (let i = 0; i < 4; i++) {
      await svc.reserve(device);
      expect((await svc.fail(device)).retryAfterSeconds).toBe(0);
    }
    await svc.reserve(device);
    const fifth = await svc.fail(device);
    expect(fifth.started.map((s) => s.scope.kind).sort()).toEqual(['ip', 'known']);
    expect(await svc.reserve(device)).toMatchObject({ allowed: false, reason: 'paused' });
    // вход с устройства не снимает паузу по логину, которую включили чужие неудачи
    await svc.reset(device);
    expect(await svc.currentSeries('login', login)).toBe(1);
    await expect(svc.assertAllowed({ ip: fresh().ip, login })).rejects.toBeInstanceOf(HttpException);

    // сессия: в имени ключа — только хеш её идентификатора
    expect(sessionScope('secret-session-id')).toMatch(/^session:[0-9a-f]{32}$/);
    expect(sessionScope('secret-session-id')).not.toContain('secret');
    expect(sessionScope('a')).not.toBe(sessionScope('b'));
  });

  it('длинный лимит неверных кодов: на двадцатом вход по коду закрывается до конца суток', async () => {
    const { login } = fresh();
    expect(SECOND_FACTOR_LIMIT).toBe(20);
    expect(SECOND_FACTOR_WINDOW_SECONDS).toBe(24 * 3600);
    for (let i = 1; i < SECOND_FACTOR_LIMIT; i++)
      expect(await svc.secondFactorFailure(login)).toEqual({ count: i, closedSeconds: 0 });
    expect(await svc.secondFactorClosedSeconds(login)).toBe(0);
    const last = await svc.secondFactorFailure(login.toUpperCase());
    expect(last.count).toBe(SECOND_FACTOR_LIMIT);
    expect(last.closedSeconds).toBeGreaterThan(24 * 3600 - 60);
    expect(last.closedSeconds).toBeLessThanOrEqual(24 * 3600);
    expect(await svc.secondFactorClosedSeconds(login)).toBeGreaterThan(24 * 3600 - 60);
    // «лимит достигнут» сообщается один раз — дальше счёт просто растёт
    expect((await svc.secondFactorFailure(login)).closedSeconds).toBe(0);
    expect(await svc.secondFactorClosedSeconds(`other-${login}`)).toBe(0);
  });

  it('сообщение о серии: раз в час на пару адрес/логин и не чаще раза в 15 минут вообще', async () => {
    await deleteByPattern(valkey, 'throttle:notified:*');
    await deleteByPattern(valkey, 'throttle:unreported:*');
    expect(NOTIFY_PAIR_COOLDOWN_SECONDS).toBe(3600);
    expect(NOTIFY_FLOOR_SECONDS).toBe(900);
    const key = fresh();
    expect(await svc.claimNotification('password', key.ip, key.login, true)).toEqual({ rejected: 0 });
    expect(await svc.claimNotification('password', key.ip, key.login, true)).toBeNull();
    // другая пара — всё равно не чаще раза в 15 минут
    const other = fresh();
    expect(await svc.claimNotification('password', other.ip, other.login, true)).toBeNull();
    // серия «пароль верный, код не подошёл» — отдельный счёт: шум перебора её не глушит
    expect(await svc.claimNotification('code', other.ip, other.login, true)).toEqual({ rejected: 0 });

    // отказы на паузах копятся до следующего сообщения
    for (let i = 0; i < 5; i++) await svc.fail(other);
    for (let i = 0; i < 3; i++) await svc.reserve(other);
    await valkey.del('throttle:notified:password:any:real'); // «прошло 15 минут»
    expect(await svc.claimNotification('password', key.ip, key.login, true)).toBeNull(); // пара ещё на кулдауне
    expect(await svc.claimNotification('password', other.ip, other.login, true)).toEqual({ rejected: 3 });
    const ttl = await valkey.ttl(`throttle:notified:password:pair:${other.ip}|${other.login}`);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
    expect(await valkey.ttl('throttle:notified:password:any:real')).toBeLessThanOrEqual(900);
  });

  it('серии по несуществующим логинам: свой интервал (час) — сообщение о настоящем логине они не глушат', async () => {
    await deleteByPattern(valkey, 'throttle:notified:*');
    expect(NOTIFY_UNKNOWN_FLOOR_SECONDS).toBe(3600);
    const scanner = fresh();
    expect(await svc.claimNotification('password', scanner.ip, 'root', false)).toEqual({ rejected: 0 });
    // тот же сканер с другим выдуманным логином и другой сканер — молчим целый час
    expect(await svc.claimNotification('password', scanner.ip, 'test', false)).toBeNull();
    expect(await svc.claimNotification('password', fresh().ip, 'oracle', false)).toBeNull();
    const ttl = await valkey.ttl('throttle:notified:password:any:unknown');
    expect(ttl).toBeGreaterThan(3500);
    // а серия по настоящему логину в это же время — приходит
    const real = fresh();
    expect(await svc.claimNotification('password', real.ip, real.login, true)).toEqual({ rejected: 0 });
    // и наоборот: сообщение о настоящем логине не занимает очередь у фона
    await valkey.del('throttle:notified:password:any:unknown');
    expect(await svc.claimNotification('password', fresh().ip, 'guest', false)).toEqual({ rejected: 0 });
  });

  it('clearAll снимает все паузы и лимиты и говорит, сколько снял', async () => {
    await deleteByPattern(valkey, 'throttle:*');
    const a = fresh();
    const b = fresh();
    for (let i = 0; i < 5; i++) await svc.fail(a);
    for (let i = 0; i < 5; i++) await svc.fail({ ...b, known: deviceScope('d-1') });
    for (let i = 0; i < SECOND_FACTOR_LIMIT; i++) await svc.secondFactorFailure(a.login);
    await svc.secondFactorFailure(b.login);
    expect(await svc.clearAll()).toEqual({ pauses: 4, codeEntryReopened: 1 });
    await expect(svc.assertAllowed(a)).resolves.toBeUndefined();
    expect(await svc.secondFactorClosedSeconds(a.login)).toBe(0);
    expect(await svc.currentSeries('login', a.login)).toBe(0);
    expect(await valkey.keys('throttle:*')).toEqual([]);
    expect(await svc.clearAll()).toEqual({ pauses: 0, codeEntryReopened: 0 });
  });
});
