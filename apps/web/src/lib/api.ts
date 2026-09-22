import { AUTH_PROBLEM, CSRF_HEADER, csrfResponseSchema } from '@nodeservice/shared';
import type { z } from 'zod';

/**
 * Тонкая обёртка над fetch для /api:
 *  - cookie-сессия (credentials: include), JSON туда и обратно;
 *  - CSRF: один раз берём токен из GET /api/auth/csrf, шлём x-csrf-token на всех не-GET,
 *    при 403 «csrf» обновляем токен и повторяем запрос ровно один раз;
 *  - application/problem+json → ApiError;
 *  - ответ проверяется zod-схемой из @nodeservice/shared.
 */

export const API_BASE = '/api';
export { CSRF_HEADER };

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  requestId?: string;
  errors?: Array<{ path: string; message: string }>;
  retryAfterSeconds?: number;
}

export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly errors: Array<{ path: string; message: string }>;
  readonly retryAfterSeconds: number | undefined;
  readonly requestId: string | undefined;
  /** Расширения RFC 9457 (например offeredFingerprint у host-key-mismatch). */
  readonly extensions: Record<string, unknown>;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.type = problem.type;
    this.title = problem.title;
    this.detail = problem.detail;
    this.errors = problem.errors ?? [];
    this.retryAfterSeconds = problem.retryAfterSeconds;
    this.requestId = problem.requestId;
    const known = new Set([
      'type',
      'title',
      'status',
      'detail',
      'instance',
      'requestId',
      'errors',
      'retryAfterSeconds',
    ]);
    this.extensions = Object.fromEntries(Object.entries(problem).filter(([k]) => !known.has(k)));
  }

  is(type: string): boolean {
    return this.type === type;
  }

  /** Ошибка про CSRF — токен протух или его не было. */
  get isCsrf(): boolean {
    return this.status === 403 && this.type === AUTH_PROBLEM.csrf;
  }

  /** Строковое расширение problem+json; null — нет или не строка. */
  extensionString(key: string): string | null {
    const v = this.extensions[key];
    return typeof v === 'string' ? v : null;
  }

  /** Сообщение по конкретному полю (из 422 validation). */
  fieldMessage(path: string): string | undefined {
    return this.errors.find((e) => e.path === path)?.message;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/** Ошибка сети / недоступный сервер (status 0 — до сервера не дошли). */
function networkError(): ApiError {
  return new ApiError({
    type: 'about:blank',
    title: 'Нет связи с сервером',
    status: 0,
    detail: 'Нет связи с сервером. Проверь сеть и попробуй ещё раз.',
  });
}

function parseRetryAfter(res: Response, body: unknown): number | undefined {
  if (body && typeof body === 'object' && 'retryAfterSeconds' in body) {
    const v = (body as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.ceil(v));
  }
  const h = res.headers.get('retry-after');
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return Math.max(0, Math.ceil(n));
  const t = Date.parse(h);
  return Number.isNaN(t) ? undefined : Math.max(0, Math.ceil((t - Date.now()) / 1000));
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json')) {
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
  } else {
    // Не JSON — прокси, nginx или упавший бэкенд.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
  }
  const p = body && typeof body === 'object' ? (body as Partial<ProblemDetails>) : {};
  return new ApiError({
    // Неизвестные ключи (расширения RFC 9457, например offeredFingerprint) — сохраняем.
    ...Object.fromEntries(
      Object.entries(p).filter(
        ([k]) =>
          ![
            'type',
            'title',
            'status',
            'detail',
            'instance',
            'requestId',
            'errors',
            'retryAfterSeconds',
          ].includes(k),
      ),
    ),
    type: typeof p.type === 'string' ? p.type : 'about:blank',
    title:
      typeof p.title === 'string'
        ? p.title
        : res.status >= 500
          ? 'Сервер недоступен'
          : `Ошибка ${res.status}`,
    status: typeof p.status === 'number' ? p.status : res.status,
    detail: typeof p.detail === 'string' ? p.detail : undefined,
    requestId: typeof p.requestId === 'string' ? p.requestId : (res.headers.get('x-request-id') ?? undefined),
    errors: Array.isArray(p.errors) ? p.errors : undefined,
    retryAfterSeconds: parseRetryAfter(res, body),
  });
}

/* ---------- CSRF ---------- */
let csrfToken: string | null = null;
let csrfInFlight: Promise<string> | null = null;

async function fetchCsrf(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/auth/csrf`, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw networkError();
  }
  if (!res.ok) throw await toApiError(res);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  const parsed = csrfResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({ type: 'about:blank', title: 'Не удалось получить CSRF-токен', status: res.status });
  }
  return parsed.data.token;
}

export async function getCsrfToken(force = false): Promise<string> {
  if (csrfToken && !force) return csrfToken;
  if (!csrfInFlight) {
    csrfInFlight = fetchCsrf()
      .then((t) => {
        csrfToken = t;
        return t;
      })
      .finally(() => {
        csrfInFlight = null;
      });
  }
  return csrfInFlight;
}

/** Сбросить кэш токена (тесты, выход из системы). */
export function resetCsrfToken(): void {
  csrfToken = null;
  csrfInFlight = null;
}

/* ---------- истёкшая сессия ---------- */
type UnauthenticatedHandler = (path: string) => void;
let onUnauthenticated: UnauthenticatedHandler | null = null;

/**
 * Пути, где 401 unauthenticated — штатный ответ (гость, неверный пароль на /unlock,
 * проверка сессии), а не признак протухшей сессии.
 */
const AUTH_FLOW_PATHS = /^\/auth\/(login(\/|$)|unlock$|me$|status$)/;

type LockedHandler = () => void;
let onLocked: LockedHandler | null = null;

/** Обработчик «экран заблокирован на сервере» (403 locked вне auth-потока): показать экран блокировки. */
export function setLockedHandler(handler: LockedHandler | null): void {
  onLocked = handler;
}

function isLocked(path: string, err: ApiError): boolean {
  return err.status === 403 && err.type === AUTH_PROBLEM.locked && !path.startsWith('/auth/');
}

/** Зарегистрировать обработчик «сессия истекла» (ставится один раз при старте приложения). */
export function setUnauthenticatedHandler(handler: UnauthenticatedHandler | null): void {
  onUnauthenticated = handler;
}

function isSessionExpired(path: string, err: ApiError): boolean {
  return err.status === 401 && err.type === AUTH_PROBLEM.unauthenticated && !AUTH_FLOW_PATHS.test(path);
}

/* ---------- запросы ---------- */
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions<TSchema extends z.ZodType> {
  method?: Method;
  body?: unknown;
  /** Схема ответа. Без неё тело не читается (204). */
  schema?: TSchema;
  signal?: AbortSignal;
}

async function doFetch(path: string, method: Method, body: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json, application/problem+json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers[CSRF_HEADER] = await getCsrfToken();
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw networkError();
  }
}

export async function request<TSchema extends z.ZodType>(
  path: string,
  options: RequestOptions<TSchema> & { schema: TSchema },
): Promise<z.output<TSchema>>;
export async function request(path: string, options?: RequestOptions<z.ZodType>): Promise<void>;
export async function request<TSchema extends z.ZodType>(
  path: string,
  options: RequestOptions<TSchema> = {},
): Promise<z.output<TSchema> | undefined> {
  const method = options.method ?? 'GET';
  let res = await doFetch(path, method, options.body, options.signal);

  if (!res.ok) {
    let err = await toApiError(res);
    if (method !== 'GET' && err.isCsrf) {
      await getCsrfToken(true);
      res = await doFetch(path, method, options.body, options.signal);
      if (!res.ok) err = await toApiError(res);
    }
    if (!res.ok) {
      if (isSessionExpired(path, err)) onUnauthenticated?.(path);
      if (isLocked(path, err)) onLocked?.();
      throw err;
    }
  }

  if (!options.schema) return undefined;
  if (res.status === 204) {
    throw new ApiError({ type: 'about:blank', title: 'Пустой ответ сервера', status: 204 });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError({ type: 'about:blank', title: 'Сервер вернул не JSON', status: res.status });
  }
  const parsed = options.schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({
      type: 'https://nodeservice.dev/problems/client/bad-response',
      title: 'Ответ сервера не совпал с контрактом',
      status: res.status,
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
  }
  return parsed.data;
}

export const api = {
  get: <S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal) =>
    request(path, { method: 'GET', schema, signal }),
  post: <S extends z.ZodType>(path: string, body: unknown, schema: S) =>
    request(path, { method: 'POST', body, schema }),
  postVoid: (path: string, body?: unknown) => request(path, { method: 'POST', body }),
  put: <S extends z.ZodType>(path: string, body: unknown, schema: S) =>
    request(path, { method: 'PUT', body, schema }),
};

/* ---------- сообщения для людей ---------- */
export function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Русское сообщение для ApiError — по type, потом по статусу. */
export function apiErrorMessage(e: unknown): string {
  if (!isApiError(e)) {
    return e instanceof Error && e.message ? e.message : 'Что-то пошло не так. Попробуй ещё раз.';
  }
  switch (e.type) {
    case AUTH_PROBLEM.invalidCredentials:
      return 'Неверный логин или пароль.';
    case AUTH_PROBLEM.throttled:
      return e.retryAfterSeconds
        ? `Слишком много неудачных попыток — пауза ${formatSeconds(e.retryAfterSeconds)}. Она растёт с каждой серией, постоянной блокировки нет.`
        : 'Слишком много неудачных попыток — подожди немного и попробуй снова.';
    case AUTH_PROBLEM.totpRequired:
      return 'Сначала подтверди вход кодом из приложения.';
    case AUTH_PROBLEM.invalidTotp:
      return 'Неверный код. Проверь время на телефоне — коды живут 30 секунд.';
    case AUTH_PROBLEM.invalidRecovery:
      return 'Этот код уже использован или не существует.';
    case AUTH_PROBLEM.setupDone:
      return 'Администратор уже создан — мастер первого запуска закрыт.';
    case AUTH_PROBLEM.setupToken:
      return 'Токен первого запуска не подошёл. Сверь его с выводом установщика или docker logs nodeservice.';
    case AUTH_PROBLEM.stepUp:
      return 'Нужно ещё раз подтвердить пароль.';
    case AUTH_PROBLEM.unauthenticated:
      return 'Сессия закончилась — войди заново.';
    case AUTH_PROBLEM.locked:
      return 'Экран заблокирован — введи пароль.';
    default:
      break;
  }
  if (e.status === 0) return 'Нет связи с сервером. Проверь сеть и попробуй ещё раз.';
  if (e.status === 422 && e.errors.length > 0) return e.errors.map((x) => x.message).join(' ');
  if (e.status >= 500) {
    return `${e.detail ?? 'Что-то пошло не так на сервере.'}${e.requestId ? ` Запрос: ${e.requestId}` : ''}`;
  }
  return e.detail ?? e.title;
}
