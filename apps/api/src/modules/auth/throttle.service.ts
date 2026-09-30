import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { THROTTLE_FREE_ATTEMPTS, THROTTLE_SCHEDULE_SECONDS } from '@nodeservice/shared';
import type { Redis } from 'ioredis';

import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { authProblems } from './auth.problems.js';
import { retryAfterSeconds, throttleIp } from './throttle.schedule.js';

/** Окно, в котором копятся неудачи одной серии. */
const FAILURE_WINDOW_SECONDS = 15 * 60;
/** Память о номере серии: час тишины (или длина паузы, если она дольше) — и расписание начинается заново. */
export const SERIES_MEMORY_SECONDS = 60 * 60;
/**
 * Сколько живёт занятая, но ещё не проверенная попытка. С запасом на очередь проверок пароля; если
 * запрос оборвался на полпути, место освободится само — без паузы, которой никто не заслужил.
 */
const HOLD_SECONDS = 60;
/** Счёт отказов во время паузы хранится до её конца и ещё час — чтобы сводка успела попасть в Журнал. */
const REJECTED_MEMORY_SECONDS = 60 * 60;
/** Отказы «с прошлого сообщения» помним сутки: дольше они владельцу ничего не скажут. */
const UNREPORTED_MEMORY_SECONDS = 24 * 60 * 60;

/** Окно длинного лимита неверных кодов второго шага. */
export const SECOND_FACTOR_WINDOW_SECONDS = 24 * 60 * 60;
/**
 * Столько неверных кодов второго шага за окно — и вход по коду из приложения для логина закрывается
 * до конца окна. Код из шести цифр подбирается перебором, поэтому общее число попыток ограничено;
 * код восстановления и запомненное устройство при этом работают.
 */
export const SECOND_FACTOR_LIMIT = 20;

/** Одна пара адрес/логин — не больше одного сообщения о серии за это время. */
export const NOTIFY_PAIR_COOLDOWN_SECONDS = 60 * 60;
/**
 * И не больше одного сообщения о сериях по настоящим логинам вообще: перебор с сотен адресов не должен
 * звенеть без остановки.
 */
export const NOTIFY_FLOOR_SECONDS = 15 * 60;
/**
 * Серии по несуществующим логинам (сканеры перебирают «root», «test»…) — отдельный счёт и реже: это фон,
 * и он не должен ни шуметь, ни занимать очередь у сообщения о настоящем логине.
 */
export const NOTIFY_UNKNOWN_FLOOR_SECONDS = 60 * 60;

export interface ThrottleKey {
  ip: string;
  login: string;
  /**
   * Запомненное устройство или открытая сессия (deviceScope / sessionScope). Такой запрос не ждёт паузу
   * по логину, которую включили чужие неудачи: у него своя пауза с тем же расписанием.
   */
  known?: string;
}

export type ThrottleScopeKind = 'ip' | 'login' | 'known';

export interface ThrottleScope {
  kind: ThrottleScopeKind;
  value: string;
}

/** Вид серии для уведомлений: неверный пароль или неверный код после верного пароля. */
export type AttemptKind = 'password' | 'code';

export type Reservation =
  | { allowed: true }
  /**
   * Идёт пауза. scope — область, к которой отнесён отказ (логин или устройство, если они на паузе, иначе
   * адрес), scopeSeconds — сколько осталось её паузе, rejected — который это отказ за неё: всё для
   * сводной записи в Журнале.
   */
  | {
      allowed: false;
      reason: 'paused';
      retryAfterSeconds: number;
      scope: ThrottleScope;
      scopeSeconds: number;
      rejected: number;
    }
  /** Паузы нет, но все свободные попытки сейчас проверяются другими запросами. */
  | { allowed: false; reason: 'busy' };

export interface FailOutcome {
  /** Сколько секунд ждать; 0 — паузы нет. */
  retryAfterSeconds: number;
  /** Паузы, включённые именно этой неудачей (пусто — порог не достигнут или пауза уже шла). */
  started: Array<{ scope: ThrottleScope; seconds: number; series: number }>;
}

/** Область пауз запомненного устройства (id из trusted_devices). */
export function deviceScope(deviceId: string): string {
  return `device:${deviceId}`;
}

/** Область пауз открытой сессии. Сам идентификатор сессии в имя ключа не кладём — только его хеш. */
export function sessionScope(sessionId: string): string {
  return `session:${createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * Занять попытку до проверки. KEYS — по четыре на область (пауза, неудачи, занятые, отказы) и в конце
 * счётчик отказов «с прошлого сообщения». Всё одним скриптом: залп параллельных запросов видит один
 * и тот же счёт и паузу не обходит. Ответ: {0} — занято; {1, мс, область, который отказ, мс паузы этой
 * области} — пауза; {2} — свободных попыток нет.
 */
const RESERVE_LUA = `
local n = (#KEYS - 1) / 4
local wait = 0
local at = 0
local own = 0
for i = 0, n - 1 do
  local ttl = redis.call('PTTL', KEYS[i * 4 + 1])
  if ttl > 0 then
    if ttl > wait then wait = ttl end
    at = i + 1
    own = ttl
  end
end
if at > 0 then
  local rejected = KEYS[(at - 1) * 4 + 4]
  local r = redis.call('INCR', rejected)
  if r == 1 then redis.call('PEXPIRE', rejected, own + tonumber(ARGV[3])) end
  redis.call('INCR', KEYS[#KEYS])
  redis.call('EXPIRE', KEYS[#KEYS], ARGV[4])
  return {1, wait, at, r, own}
end
for i = 0, n - 1 do
  local used = tonumber(redis.call('GET', KEYS[i * 4 + 2]) or '0') + tonumber(redis.call('GET', KEYS[i * 4 + 3]) or '0')
  if used >= tonumber(ARGV[1]) then return {2, 0, i + 1, 0} end
end
for i = 0, n - 1 do
  redis.call('INCR', KEYS[i * 4 + 3])
  redis.call('PEXPIRE', KEYS[i * 4 + 3], ARGV[2])
end
return {0, 0, 0, 0}
`;

/**
 * Неудача. KEYS — по четыре на область (пауза, неудачи, занятые, номер серии); ARGV: порог, окно (мс),
 * память серии (с), была ли попытка занята, дальше расписание пауз (с). Порог и включение паузы — в одном
 * скрипте: даже при гонке пауза включается один раз и номер серии растёт на единицу. Неудача, пришедшая
 * уже во время паузы, в счёт следующей серии не идёт: иначе после паузы все попытки оказались бы заняты,
 * а новой паузы не было бы. По тройке на область: {сколько ждать (мс), длина включённой сейчас паузы (с)
 * или 0, номер серии}.
 */
const FAIL_LUA = `
local n = #KEYS / 4
local out = {}
for i = 0, n - 1 do
  local block, fail, hold, series = KEYS[i * 4 + 1], KEYS[i * 4 + 2], KEYS[i * 4 + 3], KEYS[i * 4 + 4]
  if ARGV[4] == '1' and tonumber(redis.call('GET', hold) or '0') > 0 then redis.call('DECR', hold) end
  local ttl = redis.call('PTTL', block)
  if ttl > 0 then
    out[#out + 1] = ttl
    out[#out + 1] = 0
    out[#out + 1] = 0
  else
    local f = redis.call('INCR', fail)
    if f == 1 or redis.call('PTTL', fail) < 0 then redis.call('PEXPIRE', fail, ARGV[2]) end
    if f >= tonumber(ARGV[1]) then
      local s = redis.call('INCR', series)
      local idx = s
      if idx > #ARGV - 4 then idx = #ARGV - 4 end
      local sec = tonumber(ARGV[4 + idx])
      local memory = tonumber(ARGV[3])
      if sec > memory then memory = sec end
      redis.call('EXPIRE', series, memory)
      redis.call('SET', block, s, 'EX', sec)
      redis.call('DEL', fail)
      out[#out + 1] = sec * 1000
      out[#out + 1] = sec
      out[#out + 1] = s
    else
      out[#out + 1] = 0
      out[#out + 1] = 0
      out[#out + 1] = 0
    end
  end
end
return out
`;

/** Вернуть занятую попытку. Счёт неудач и пауза не трогаются: возврат ничего не «прощает». */
const RELEASE_LUA = `
for i = 1, #KEYS do
  if tonumber(redis.call('GET', KEYS[i]) or '0') > 0 then redis.call('DECR', KEYS[i]) end
end
return 1
`;

/** Неверный код второго шага: счёт за окно. Ответ: {сколько набралось, сколько окну осталось (мс)}. */
const SECOND_FACTOR_LUA = `
local n = redis.call('INCR', KEYS[1])
if n == 1 or redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}
`;

/**
 * Право на сообщение о серии: KEYS — пара адрес/логин, общий ключ вида серии, счётчик отказов.
 * -1 — сообщение недавно уже было; иначе — сколько попыток отклонено с прошлого сообщения.
 */
const CLAIM_LUA = `
if redis.call('EXISTS', KEYS[1]) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
local r = tonumber(redis.call('GET', KEYS[3]) or '0')
redis.call('DEL', KEYS[3])
return r
`;

/**
 * Неудачи подряд по адресу и по логину (или по запомненному устройству). После THROTTLE_FREE_ATTEMPTS —
 * пауза по расписанию THROTTLE_SCHEDULE_SECONDS, растущая с каждой серией; полный вход всё сбрасывает.
 * Попытка занимается до проверки пароля или кода и возвращается при успехе: счёт ведётся в Valkey
 * одним скриптом, поэтому параллельные запросы паузу не обходят.
 */
@Injectable()
export class ThrottleService {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  /** Бросает 429, если адрес или логин сейчас на паузе. Только проверка: попытку не занимает. */
  async assertAllowed(key: ThrottleKey): Promise<void> {
    const ttls = await Promise.all(scopesOf(key).map((s) => this.valkey.pttl(scopeKey('block', s))));
    const wait = Math.max(0, ...ttls);
    if (wait > 0) throw authProblems.throttled(retryAfterSeconds(wait));
  }

  /**
   * Занимает попытку до проверки пароля или кода. Свободных попыток на серию — THROTTLE_FREE_ATTEMPTS
   * вместе с уже неудачными: сколько бы запросов ни пришло разом, проверяться будут не больше этого.
   */
  async reserve(key: ThrottleKey, kind: AttemptKind = 'password'): Promise<Reservation> {
    const scopes = scopesOf(key);
    const keys = scopes.flatMap((s) => [
      scopeKey('block', s),
      scopeKey('fail', s),
      scopeKey('hold', s),
      scopeKey('rejected', s),
    ]);
    const [code = 0, wait = 0, at = 0, rejected = 0, own = 0] = (await this.valkey.eval(
      RESERVE_LUA,
      keys.length + 1,
      ...keys,
      unreportedKey(kind),
      THROTTLE_FREE_ATTEMPTS,
      HOLD_SECONDS * 1000,
      REJECTED_MEMORY_SECONDS * 1000,
      UNREPORTED_MEMORY_SECONDS,
    )) as number[];
    if (code === 0) return { allowed: true };
    if (code === 2) return { allowed: false, reason: 'busy' };
    return {
      allowed: false,
      reason: 'paused',
      retryAfterSeconds: retryAfterSeconds(wait),
      scope: scopes[at - 1] ?? ipScope(key.ip),
      scopeSeconds: retryAfterSeconds(own),
      rejected,
    };
  }

  /** Занятая попытка не удалась: остаётся в счёте; на пороге включается пауза. */
  fail(key: ThrottleKey): Promise<FailOutcome> {
    return this.countFailure(key, true);
  }

  /** Проверка прошла, но вход ещё не полный (ждём код): попытка возвращается, счёт неудач остаётся. */
  async release(key: ThrottleKey): Promise<void> {
    const keys = scopesOf(key).map((s) => scopeKey('hold', s));
    await this.valkey.eval(RELEASE_LUA, keys.length, ...keys);
  }

  /** Регистрирует неудачу без занятой попытки; если достигнут порог — включает паузу и бросает 429. */
  async recordFailure(key: ThrottleKey): Promise<void> {
    const outcome = await this.countFailure(key, false);
    if (outcome.retryAfterSeconds > 0) throw authProblems.throttled(outcome.retryAfterSeconds);
  }

  /** Полный вход: сбрасываем счётчики, паузы и память о сериях для областей этого ключа. */
  async reset(key: ThrottleKey): Promise<void> {
    await this.valkey.del(
      ...scopesOf(key).flatMap((s) => [
        scopeKey('fail', s),
        scopeKey('hold', s),
        scopeKey('block', s),
        scopeKey('series', s),
      ]),
    );
  }

  /** Сколько секунд блокировки получит следующая серия (для тестов/диагностики). */
  async currentSeries(kind: ThrottleScopeKind, value: string): Promise<number> {
    const scope = kind === 'ip' ? ipScope(value) : kind === 'login' ? loginScope(value) : { kind, value };
    const raw = await this.valkey.get(scopeKey('series', scope));
    return raw ? Number(raw) : 0;
  }

  /** Сколько попыток отклонено за паузу в этой области; счётчик при чтении обнуляется. */
  async takeRejected(scope: ThrottleScope): Promise<number> {
    const raw = await this.valkey.getdel(scopeKey('rejected', scope));
    return raw ? Number(raw) : 0;
  }

  /* ---------- длинный лимит неверных кодов второго шага ---------- */

  /** Сколько секунд вход по коду из приложения для логина ещё закрыт; 0 — открыт. */
  async secondFactorClosedSeconds(login: string): Promise<number> {
    const key = secondFactorKey(login);
    const [raw, ttl] = await Promise.all([this.valkey.get(key), this.valkey.pttl(key)]);
    return Number(raw ?? 0) >= SECOND_FACTOR_LIMIT && ttl > 0 ? retryAfterSeconds(ttl) : 0;
  }

  /**
   * Неверный код второго шага (из приложения или восстановления). closedSeconds > 0 — лимит достигнут
   * именно этой неудачей: вход по коду из приложения закрыт до конца окна.
   */
  async secondFactorFailure(login: string): Promise<{ count: number; closedSeconds: number }> {
    const [count = 0, ttl = 0] = (await this.valkey.eval(
      SECOND_FACTOR_LUA,
      1,
      secondFactorKey(login),
      SECOND_FACTOR_WINDOW_SECONDS * 1000,
    )) as number[];
    return { count, closedSeconds: count === SECOND_FACTOR_LIMIT ? retryAfterSeconds(ttl) : 0 };
  }

  /* ---------- уведомления о сериях ---------- */

  /**
   * Можно ли сейчас прислать сообщение о серии. null — недавно уже присылали (этой паре адрес/логин или
   * вообще о таких сериях); иначе — сколько попыток отклонено на паузах с прошлого сообщения.
   * loginExists — логин настоящий: у настоящих и несуществующих логинов общий интервал свой, поэтому
   * серией по выдуманному логину нельзя заглушить сообщение о подборе пароля к настоящему.
   */
  async claimNotification(
    kind: AttemptKind,
    ip: string,
    login: string,
    loginExists: boolean,
  ): Promise<{ rejected: number } | null> {
    const rejected = (await this.valkey.eval(
      CLAIM_LUA,
      3,
      `throttle:notified:${kind}:pair:${throttleIp(ip)}|${normalize(login)}`,
      `throttle:notified:${kind}:any:${loginExists ? 'real' : 'unknown'}`,
      unreportedKey(kind),
      NOTIFY_PAIR_COOLDOWN_SECONDS,
      loginExists ? NOTIFY_FLOOR_SECONDS : NOTIFY_UNKNOWN_FLOOR_SECONDS,
    )) as number;
    return rejected < 0 ? null : { rejected };
  }

  /* ---------- консоль сервера ---------- */

  /**
   * Снять все паузы входа и обнулить счётчики (команды консоли сервера): оператор у консоли не знает,
   * с какого адреса его не пускает панель, поэтому снимается всё разом.
   */
  async clearAll(): Promise<{ pauses: number; codeEntryReopened: number }> {
    let pauses = 0;
    let codeEntryReopened = 0;
    let cursor = '0';
    do {
      const [next, keys] = await this.valkey.scan(cursor, 'MATCH', 'throttle:*', 'COUNT', 500);
      cursor = next;
      for (const key of keys) {
        if (key.startsWith('throttle:block:')) pauses += 1;
        else if (key.startsWith('throttle:2fa:') && Number(await this.valkey.get(key)) >= SECOND_FACTOR_LIMIT)
          codeEntryReopened += 1;
      }
      if (keys.length > 0) await this.valkey.del(...keys);
    } while (cursor !== '0');
    return { pauses, codeEntryReopened };
  }

  private async countFailure(key: ThrottleKey, reserved: boolean): Promise<FailOutcome> {
    const scopes = scopesOf(key);
    const keys = scopes.flatMap((s) => [
      scopeKey('block', s),
      scopeKey('fail', s),
      scopeKey('hold', s),
      scopeKey('series', s),
    ]);
    const raw = (await this.valkey.eval(
      FAIL_LUA,
      keys.length,
      ...keys,
      THROTTLE_FREE_ATTEMPTS,
      FAILURE_WINDOW_SECONDS * 1000,
      SERIES_MEMORY_SECONDS,
      reserved ? '1' : '0',
      ...THROTTLE_SCHEDULE_SECONDS,
    )) as number[];
    let wait = 0;
    const started: FailOutcome['started'] = [];
    scopes.forEach((scope, i) => {
      const [ms = 0, seconds = 0, series = 0] = raw.slice(i * 3, i * 3 + 3);
      wait = Math.max(wait, ms);
      if (seconds > 0) started.push({ scope, seconds, series });
    });
    return { retryAfterSeconds: wait > 0 ? retryAfterSeconds(wait) : 0, started };
  }
}

function normalize(login: string): string {
  return login.trim().toLowerCase();
}

function ipScope(ip: string): ThrottleScope {
  return { kind: 'ip', value: throttleIp(ip) };
}

function loginScope(login: string): ThrottleScope {
  return { kind: 'login', value: normalize(login) };
}

/** Области ключа: адрес и логин; у запомненного устройства и открытой сессии вместо логина — своя. */
function scopesOf(key: ThrottleKey): ThrottleScope[] {
  return [ipScope(key.ip), key.known ? { kind: 'known', value: key.known } : loginScope(key.login)];
}

function scopeKey(what: 'block' | 'fail' | 'hold' | 'series' | 'rejected', scope: ThrottleScope): string {
  return `throttle:${what}:${scope.kind}:${scope.value}`;
}

function secondFactorKey(login: string): string {
  return `throttle:2fa:${normalize(login)}`;
}

function unreportedKey(kind: AttemptKind): string {
  return `throttle:unreported:${kind}`;
}
