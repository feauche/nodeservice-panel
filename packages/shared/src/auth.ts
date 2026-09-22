import { z } from 'zod';

/**
 * Контракт auth API (этап 1). Одни и те же схемы использует бэкенд (nestjs-zod DTO)
 * и фронт (react-hook-form + zodResolver, типы ответов).
 *
 * Маршруты (все под /api/auth):
 *  GET  /status                → AuthStatus            (нужен ли первый запуск, есть ли сессия)
 *  POST /setup/start           → SetupStartResponse    (setup-токен + логин + пароль → секрет TOTP)
 *  POST /setup/confirm         → SetupConfirmResponse  (код из приложения → коды восстановления, сессия)
 *  POST /login                 → LoginResponse         (пароль → сессия или шаг TOTP)
 *  POST /login/totp            → SessionResponse
 *  POST /login/recovery        → SessionResponse
 *  POST /unlock                → SessionResponse       (экран блокировки: пароль ещё раз)
 *  POST /logout                → 204 (идемпотентно, всегда чистит cookie)
 *  GET  /me                    → Me
 *  GET  /csrf                  → CsrfResponse         (токен для заголовка x-csrf-token)
 */

export const LOGIN_MIN = 3;
export const LOGIN_MAX = 32;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const RECOVERY_CODE_RE = /^[A-Z2-9]{5}-?[A-Z2-9]{5}$/i;

export const loginSchema = z
  .string()
  .trim()
  .min(LOGIN_MIN, `Логин — от ${LOGIN_MIN} символов`)
  .max(LOGIN_MAX, `Логин — до ${LOGIN_MAX} символов`)
  .regex(/^[a-z0-9_.-]+$/i, 'Только латиница, цифры, точка, дефис и подчёркивание');

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN, `Пароль — от ${PASSWORD_MIN} символов. Фраза из 3–4 слов подойдёт лучше всего`)
  .max(PASSWORD_MAX, `Пароль — до ${PASSWORD_MAX} символов`);

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Код — 6 цифр');

export const recoveryCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(RECOVERY_CODE_RE, 'Формат кода — 10 символов, например K7QFM-2M9XT');

/* ---------- CSRF ---------- */
export const CSRF_HEADER = 'x-csrf-token';
export const csrfResponseSchema = z.object({ token: z.string().min(1) });
export type CsrfResponse = z.infer<typeof csrfResponseSchema>;

/* ---------- статус ---------- */
export const authStatusSchema = z.object({
  /** Администратора ещё нет — показать мастер первого запуска. */
  setupRequired: z.boolean(),
  /** Есть валидная сессия. */
  authenticated: z.boolean(),
  /** Сессия есть, но экран заблокирован (вручную или по бездействию) — нужен пароль. */
  locked: z.boolean().default(false),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

/* ---------- первый запуск ---------- */
export const setupStartRequestSchema = z.object({
  setupToken: z.string().trim().min(8, 'Нужен токен первого запуска — он в выводе установщика'),
  login: loginSchema,
  password: passwordSchema,
});
export type SetupStartRequest = z.infer<typeof setupStartRequestSchema>;

export const setupStartResponseSchema = z.object({
  /** Секрет base32 — показать для ручного ввода. */
  totpSecret: z.string(),
  /** otpauth://… для QR-кода. */
  otpauthUrl: z.string(),
  /** Готовый QR (data:image/svg+xml;…). */
  qrDataUrl: z.string(),
});
export type SetupStartResponse = z.infer<typeof setupStartResponseSchema>;

export const setupConfirmRequestSchema = z.object({
  code: totpCodeSchema,
});
export type SetupConfirmRequest = z.infer<typeof setupConfirmRequestSchema>;

export const setupConfirmResponseSchema = z.object({
  /** 10 одноразовых кодов — показываются один раз. */
  recoveryCodes: z.array(z.string()).length(10),
});
export type SetupConfirmResponse = z.infer<typeof setupConfirmResponseSchema>;

/* ---------- вход ---------- */
export const loginRequestSchema = z.object({
  login: z.string().trim().min(1, 'Введите логин').max(LOGIN_MAX),
  password: z.string().min(1, 'Введите пароль').max(PASSWORD_MAX),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const meSchema = z.object({
  id: z.string(),
  login: z.string(),
  /** Способы, которыми подтверждена сессия: pwd, totp, recovery, trusted. */
  amr: z.array(z.enum(['pwd', 'totp', 'recovery', 'trusted'])),
  createdAt: z.string(),
  /** Когда последний раз вводили пароль (для step-up). */
  stepUpAt: z.string().nullable(),
  /** Сколько кодов восстановления осталось (для подсказок на экранах 2FA/восстановления). */
  recoveryCodesLeft: z.number().int().min(0),
  /** Экран заблокирован на сервере: до /auth/unlock остальные запросы получают 403 locked. */
  locked: z.boolean().default(false),
});
export type Me = z.infer<typeof meSchema>;

export const loginResponseSchema = z.discriminatedUnion('next', [
  z.object({ next: z.literal('totp') }),
  z.object({ next: z.literal('done'), me: meSchema }),
]);
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const totpLoginRequestSchema = z.object({
  code: totpCodeSchema,
  /** Не спрашивать код на этом устройстве 30 дней. */
  rememberDevice: z.boolean().default(false),
});
export type TotpLoginRequest = z.infer<typeof totpLoginRequestSchema>;

export const recoveryLoginRequestSchema = z.object({
  code: recoveryCodeSchema,
});
export type RecoveryLoginRequest = z.infer<typeof recoveryLoginRequestSchema>;

export const unlockRequestSchema = z.object({
  password: z.string().min(1, 'Введите пароль').max(PASSWORD_MAX),
});
export type UnlockRequest = z.infer<typeof unlockRequestSchema>;

export const sessionResponseSchema = z.object({
  me: meSchema,
  /** Сколько кодов восстановления осталось (после входа по коду). */
  recoveryCodesLeft: z.number().int().optional(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/* ---------- ошибки (type в problem+json) ---------- */
export const AUTH_PROBLEM = {
  invalidCredentials: 'https://nodeservice.dev/problems/auth/invalid-credentials',
  throttled: 'https://nodeservice.dev/problems/auth/throttled',
  totpRequired: 'https://nodeservice.dev/problems/auth/totp-required',
  invalidTotp: 'https://nodeservice.dev/problems/auth/invalid-totp',
  invalidRecovery: 'https://nodeservice.dev/problems/auth/invalid-recovery-code',
  setupDone: 'https://nodeservice.dev/problems/auth/setup-already-done',
  setupToken: 'https://nodeservice.dev/problems/auth/invalid-setup-token',
  stepUp: 'https://nodeservice.dev/problems/auth/step-up-required',
  /** Экран заблокирован — сначала POST /auth/unlock. */
  locked: 'https://nodeservice.dev/problems/auth/locked',
  unauthenticated: 'https://nodeservice.dev/problems/auth/unauthenticated',
  csrf: 'https://nodeservice.dev/problems/csrf',
  validation: 'https://nodeservice.dev/problems/validation',
} as const;

/** Расширение problem+json для AUTH_PROBLEM.throttled (дублируется заголовком Retry-After). */
export const throttledProblemExtensionSchema = z.object({ retryAfterSeconds: z.number().int().positive() });

/** Расписание пауз после 5 неудач подряд: 30 с → 1 мин → 5 → 15 (по IP и по логину). */
export const THROTTLE_SCHEDULE_SECONDS = [30, 60, 300, 900] as const;
export const THROTTLE_FREE_ATTEMPTS = 5;
export const TRUSTED_DEVICE_DAYS = 30;
export const TRUSTED_DEVICE_MAX = 5;
export const RECOVERY_CODES_COUNT = 10;
