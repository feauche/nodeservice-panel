import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HEARTBEAT_DEFAULTS,
  HEARTBEAT_EVERY_SECONDS,
  HEARTBEAT_PROBLEM,
  HEARTBEAT_RECENT_MINUTES,
  HEARTBEAT_TIMEOUT_SECONDS,
  type HeartbeatAttempt,
  type HeartbeatResult,
  type HeartbeatSettings,
  type HeartbeatStatus,
  type HeartbeatTestResponse,
  type HeartbeatView,
  heartbeatSettingsSchema,
  SHARED_VERSION,
} from '@nodeservice/shared';
import { eq } from 'drizzle-orm';

import { problem } from '../../common/filters/problem-details.filter.js';
import type { Env } from '../../config/env.schema.js';
import { DB, type Db } from '../../infra/db/db.module.js';
import { appMeta } from '../../infra/db/schema/index.js';
import { isPrivateHost } from '../providers/icon-fetch.service.js';
import { PanelReadiness } from './panel-readiness.js';

const KEY = 'settings.heartbeat';
/** Сервисы проверки иногда переводят на https или на свой адрес — пару переходов прощаем. */
export const HEARTBEAT_MAX_REDIRECTS = 2;
/** Проверочный сигнал из настроек — не чаще раза в 5 секунд. */
export const HEARTBEAT_TEST_EVERY_MS = 5_000;
const TIMEOUT_MS = HEARTBEAT_TIMEOUT_SECONDS * 1000;
/** Попыток в час — около 60; запас на проверочные сигналы из настроек. */
const RECENT_MAX = 120;

export const HEARTBEAT_PRIVATE_TEXT = 'адрес ведёт во внутреннюю сеть — нужен адрес внешнего сервиса';

/** Куда ведёт имя: во внешнюю сеть, во внутреннюю или никуда (имя не нашлось). */
export type AddressKind = 'public' | 'private' | 'unresolved';

async function addressKind(host: string): Promise<AddressKind> {
  if (isPrivateHost(host)) return 'private';
  if (isIP(host.replace(/^\[|\]$/g, ''))) return 'public';
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    if (!addrs.length) return 'unresolved';
    return addrs.some((a) => isPrivateHost(a.address)) ? 'private' : 'public';
  } catch {
    return 'unresolved';
  }
}

/** Код сетевой ошибки undici (`fetch failed` → cause.code) или имя ошибки (TimeoutError, AbortError). */
function errorCode(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown; name?: unknown } } | null;
  // У DOMException `code` — число (20, 23): берём имя.
  for (const v of [e?.cause?.code, e?.code, e?.name, e?.cause?.name])
    if (typeof v === 'string' && v && v !== 'Error' && v !== 'TypeError') return v;
  return '';
}

/** Причина по-русски, без текста исключения: в нём бывает адрес с ключом сервиса. */
export function sendProblem(err: unknown): string {
  const code = errorCode(err);
  if (code === 'TimeoutError' || code === 'AbortError' || code === 'UND_ERR_HEADERS_TIMEOUT')
    return `нет ответа за ${HEARTBEAT_TIMEOUT_SECONDS} с`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'имя сервера не найдено';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) return 'сертификат https не прошёл проверку';
  return 'нет связи с адресом';
}

/** Хост для лога и Журнала: сам адрес не пишем — в пути у сервисов секретный ключ. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '—';
  }
}

interface SendOutcome {
  ok: boolean;
  httpStatus: number | null;
  ms: number;
  problem: string | null;
}

/**
 * Сигнал «панель жива» внешнему сервису проверки. Пока панель готова (база, Valkey, поиск событий — та же
 * проверка, что /api/health/ready), раз в минуту открываем адрес сервиса; не готова — НЕ шлём: сервис не
 * дождётся сигнала и сам пришлёт тревогу. Адрес — в app_meta, что было с сигналом — в памяти.
 */
@Injectable()
export class HeartbeatService {
  private readonly log = new Logger(HeartbeatService.name);
  /** Свойствами: модульные тесты подменяют сеть, разбор имени и часы. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  addressKind: (host: string) => Promise<AddressKind> = addressKind;
  now: () => number = () => Date.now();

  private lastAttemptAt: string | null = null;
  private lastOkAt: string | null = null;
  private lastResult: HeartbeatResult | null = null;
  private consecutiveFailures = 0;
  private recent: HeartbeatAttempt[] = [];
  private inFlight: Promise<void> | null = null;
  private lastTestAt = 0;
  private readonly testEnv: boolean;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly readiness: PanelReadiness,
    config: ConfigService<Env, true>,
  ) {
    this.testEnv = config.get('NODE_ENV') === 'test';
  }

  async getSettings(): Promise<HeartbeatSettings> {
    const row = await this.db.query.appMeta.findFirst({ where: eq(appMeta.key, KEY) });
    if (!row) return HEARTBEAT_DEFAULTS;
    try {
      const parsed = heartbeatSettingsSchema.safeParse(JSON.parse(row.value));
      if (parsed.success) return parsed.data;
    } catch {
      /* ниже — предупреждение и выключенный сигнал */
    }
    this.log.warn('Настройка сигнала «панель жива» повреждена — сигнал выключен до сохранения');
    return HEARTBEAT_DEFAULTS;
  }

  status(): HeartbeatStatus {
    return {
      everySeconds: HEARTBEAT_EVERY_SECONDS,
      lastAttemptAt: this.lastAttemptAt,
      lastOkAt: this.lastOkAt,
      lastResult: this.lastResult,
      consecutiveFailures: this.consecutiveFailures,
      recent: this.recentWindow(),
    };
  }

  /** Попытки за последний час: старше — отбрасываем. */
  private recentWindow(): HeartbeatAttempt[] {
    const since = this.now() - HEARTBEAT_RECENT_MINUTES * 60_000;
    this.recent = this.recent.filter((a) => Date.parse(a.at) > since).slice(-RECENT_MAX);
    return [...this.recent];
  }

  async view(): Promise<HeartbeatView> {
    return { url: (await this.getSettings()).url, status: this.status() };
  }

  /**
   * Сохранить адрес. Внутренняя сеть — 400 с ошибкой у поля. Адрес сменился — прежние итоги к нему не относятся:
   * сбрасываем и сразу шлём первый сигнал (в фоне), чтобы сервис увидел панель, не дожидаясь минуты.
   */
  async update(next: HeartbeatSettings): Promise<{ view: HeartbeatView; before: string; after: string }> {
    const parsed = heartbeatSettingsSchema.parse(next);
    if (parsed.url && (await this.kindOf(parsed.url)) === 'private')
      throw problem(HttpStatus.BAD_REQUEST, {
        type: HEARTBEAT_PROBLEM.privateAddress,
        detail: 'Адрес ведёт во внутреннюю сеть. Нужен адрес внешнего сервиса проверки.',
        errors: [{ path: 'url', message: 'Нужен адрес внешнего сервиса, не внутренней сети' }],
      });
    const before = (await this.getSettings()).url;
    const serialized = JSON.stringify(parsed);
    await this.db
      .insert(appMeta)
      .values({ key: KEY, value: serialized })
      .onConflictDoUpdate({ target: appMeta.key, set: { value: serialized, updatedAt: new Date() } });
    if (parsed.url !== before) {
      this.reset();
      if (parsed.url) void this.beat();
    }
    return { view: { url: parsed.url, status: this.status() }, before, after: parsed.url };
  }

  /**
   * Очередной сигнал (раз в минуту из задачи). Пока идёт прошлый — новый не начинаем.
   * Адреса нет — ничего; панель не готова — не шлём и записываем почему.
   */
  beat(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.beatOnce()
      .catch((err) => this.log.warn(`Сигнал «панель жива»: ${(err as Error).message}`))
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Проверочный сигнал из настроек: шлём даже неготовой панели, но говорим об этом. */
  async test(url?: string): Promise<HeartbeatTestResponse & { host: string }> {
    const now = this.now();
    if (now - this.lastTestAt < HEARTBEAT_TEST_EVERY_MS) {
      const retryAfterSeconds = Math.ceil((HEARTBEAT_TEST_EVERY_MS - (now - this.lastTestAt)) / 1000);
      throw problem(HttpStatus.TOO_MANY_REQUESTS, {
        type: HEARTBEAT_PROBLEM.tooOften,
        detail: `Проверочный сигнал — не чаще раза в ${HEARTBEAT_TEST_EVERY_MS / 1000} секунд. Подождите ${retryAfterSeconds} с.`,
        extensions: { retryAfterSeconds },
        headers: { 'Retry-After': String(retryAfterSeconds) },
      });
    }
    const saved = (await this.getSettings()).url;
    const target = url || saved;
    if (!target)
      throw problem(HttpStatus.BAD_REQUEST, {
        type: HEARTBEAT_PROBLEM.noUrl,
        detail: 'Сначала укажите адрес сервиса проверки.',
        errors: [{ path: 'url', message: 'Укажите адрес сервиса проверки' }],
      });
    this.lastTestAt = now;
    const ready = await this.readiness.check();
    const sent = await this.send(target);
    // Проверили сохранённый адрес — это настоящий сигнал сервису: учитываем его в состоянии.
    if (target === saved) this.record({ ...sent, sent: true });
    return { ...sent, ready: ready.ok, notReady: ready.problems, host: hostOf(target) };
  }

  private async beatOnce(): Promise<void> {
    const { url } = await this.getSettings();
    if (!url) return;
    const ready = await this.readiness.check();
    if (!ready.ok) {
      this.record({
        ok: false,
        sent: false,
        httpStatus: null,
        ms: null,
        problem: `не отправлен: ${ready.problems.join('; ')}`,
      });
      return;
    }
    // Адрес сменили или выключили, пока проверяли готовность, — этот итог уже ни к чему.
    const outcome = await this.send(url);
    if ((await this.getSettings()).url !== url) return;
    this.record({ ...outcome, sent: true });
  }

  private record(r: Omit<HeartbeatResult, 'at'>): void {
    const at = new Date(this.now()).toISOString();
    this.lastAttemptAt = at;
    this.lastResult = { ...r, at };
    this.recent.push({ at, outcome: r.ok ? 'ok' : r.sent ? 'failed' : 'held' });
    if (this.recent.length > RECENT_MAX) this.recent.shift();
    if (r.ok) {
      this.lastOkAt = at;
      this.consecutiveFailures = 0;
    } else this.consecutiveFailures += 1;
  }

  private reset(): void {
    this.lastAttemptAt = null;
    this.lastOkAt = null;
    this.lastResult = null;
    this.consecutiveFailures = 0;
    this.recent = [];
  }

  /** В сквозных тестах «сервис» — локальный сервер: проверку внутренних адресов там не делаем. */
  private kindOf(url: string): Promise<AddressKind> {
    if (this.testEnv) return Promise.resolve('public');
    try {
      return this.addressKind(new URL(url).hostname);
    } catch {
      return Promise.resolve('unresolved');
    }
  }

  /**
   * Один GET на адрес сервиса: 10 с на всё, переходы — вручную и не больше двух, каждый снова проверяется
   * на внутреннюю сеть. 2xx — сигнал принят. Ответ сервиса не читаем.
   */
  private async send(url: string): Promise<SendOutcome> {
    const started = performance.now();
    const ms = () => Math.round(performance.now() - started);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    let current = url;
    try {
      for (let hop = 0; ; hop += 1) {
        const kind = await this.kindOf(current);
        if (kind === 'private')
          return { ok: false, httpStatus: null, ms: ms(), problem: HEARTBEAT_PRIVATE_TEXT };
        if (kind === 'unresolved')
          return { ok: false, httpStatus: null, ms: ms(), problem: 'имя сервера не найдено' };
        const res = await this.fetchImpl(current, {
          method: 'GET',
          headers: { 'user-agent': `nodeservice-panel/${SHARED_VERSION}` },
          redirect: 'manual',
          signal,
        });
        await res.body?.cancel().catch(() => undefined);
        const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
        if (!location) {
          if (res.ok) return { ok: true, httpStatus: res.status, ms: ms(), problem: null };
          return { ok: false, httpStatus: res.status, ms: ms(), problem: `сервис ответил ${res.status}` };
        }
        if (hop >= HEARTBEAT_MAX_REDIRECTS)
          return { ok: false, httpStatus: res.status, ms: ms(), problem: 'слишком много перенаправлений' };
        const next = new URL(location, current);
        if (next.protocol !== 'https:' && next.protocol !== 'http:')
          return {
            ok: false,
            httpStatus: res.status,
            ms: ms(),
            problem: 'перенаправление на неподходящий адрес',
          };
        current = next.href;
      }
    } catch (err) {
      const text = signal.aborted ? `нет ответа за ${HEARTBEAT_TIMEOUT_SECONDS} с` : sendProblem(err);
      const raw = `${errorCode(err)} ${(err as Error)?.message ?? ''}`
        .replaceAll(url, hostOf(url))
        .replaceAll(current, hostOf(current));
      this.log.warn(`Сигнал «панель жива» на ${hostOf(url)}: ${text} (${raw.trim()})`);
      return { ok: false, httpStatus: null, ms: ms(), problem: text };
    }
  }
}
