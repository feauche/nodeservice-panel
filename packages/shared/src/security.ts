import { z } from 'zod';

import { meSchema, PASSWORD_MAX, passwordSchema, setupStartResponseSchema, totpCodeSchema } from './auth.js';

/**
 * Контракт «Безопасность и сессии» (этап 3).
 *
 *  GET  /api/security/overview                 → SecurityOverview
 *  POST /api/security/password                 → ChangePasswordResponse   (текущий пароль = step-up)
 *  POST /api/security/totp/reissue             → TotpReissueResponse      (step-up)
 *  POST /api/security/totp/confirm             → TotpConfirmResponse
 *  GET  /api/security/recovery-codes           → RecoveryCodesView          (step-up, пишется в Журнал)
 *  POST /api/security/recovery-codes           → RecoveryRegenerateResponse (step-up)
 *  GET  /api/security/sessions                 → SessionsResponse
 *  DELETE /api/security/sessions/:id           → RevokeResult
 *  POST /api/security/sessions/revoke-others   → RevokeResult
 *  GET  /api/security/trusted-devices          → TrustedDevicesResponse
 *  DELETE /api/security/trusted-devices/:id    → RevokeResult
 *  POST /api/security/trusted-devices/clear    → RevokeResult
 *  PUT  /api/security/policy                   → SecurityPolicy           (step-up)
 *
 * Step-up: пароль подтверждён не раньше STEP_UP_MINUTES назад (POST /api/auth/unlock),
 * иначе 403 AUTH_PROBLEM.stepUp — фронт спрашивает пароль и повторяет запрос.
 */

export const STEP_UP_MINUTES = 5;
export const RECOVERY_CODES_TOTAL = 10;

/* ---------- политика ---------- */
export const SESSION_IDLE_MIN = 5;
export const SESSION_IDLE_MAX = 24 * 60;
export const LOCK_AFTER_MAX = 4 * 60;

const policyFields = {
  /** Завершать сессию после N минут бездействия (скользящий TTL на сервере). */
  idleMinutes: z.number().int().min(SESSION_IDLE_MIN).max(SESSION_IDLE_MAX),
  /** Блокировать экран после N минут без запросов (на сервере: действует и в новой вкладке); 0 — выключено. */
  lockAfterMinutes: z.number().int().min(0).max(LOCK_AFTER_MAX),
  /** Всегда спрашивать код 2FA — запомненные устройства не действуют. */
  alwaysAskTotp: z.boolean(),
};

export const securityPolicySchema = z.object({
  idleMinutes: policyFields.idleMinutes.default(360),
  lockAfterMinutes: policyFields.lockAfterMinutes.default(30),
  alwaysAskTotp: policyFields.alwaysAskTotp.default(false),
});
export type SecurityPolicy = z.infer<typeof securityPolicySchema>;

export const securityPolicyUpdateSchema = z.object(policyFields).partial();
export type SecurityPolicyUpdate = z.infer<typeof securityPolicyUpdateSchema>;

/**
 * По умолчанию: сессия живёт 6 часов без запросов (абсолютный максимум — SESSION_ABSOLUTE_HOURS),
 * а через 30 минут бездействия сервер блокирует экран — дальше нужен только пароль, не полный вход.
 */
export const SECURITY_POLICY_DEFAULTS: SecurityPolicy = {
  idleMinutes: 360,
  lockAfterMinutes: 30,
  alwaysAskTotp: false,
};

/** Варианты для выпадающих списков (минуты). */
export const IDLE_MINUTES_OPTIONS = [15, 30, 60, 120, 240, 360, 480, 720] as const;
export const LOCK_AFTER_OPTIONS = [0, 5, 10, 15, 30, 60] as const;

/* ---------- обзор ---------- */
export const securityOverviewSchema = z.object({
  login: z.string(),
  passwordChangedAt: z.iso.datetime({ offset: true }),
  totpConfirmedAt: z.iso.datetime({ offset: true }).nullable(),
  recoveryCodesLeft: z.number().int().min(0),
  recoveryCodesTotal: z.number().int().min(1),
  sessionsCount: z.number().int().min(0),
  trustedDevicesCount: z.number().int().min(0),
  policy: securityPolicySchema,
});
export type SecurityOverview = z.infer<typeof securityOverviewSchema>;

/* ---------- пароль ---------- */
export const changePasswordRequestSchema = z
  .object({
    currentPassword: z.string().min(1, 'Введите текущий пароль').max(PASSWORD_MAX),
    newPassword: passwordSchema,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'Новый пароль совпадает с текущим',
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const changePasswordResponseSchema = z.object({
  me: meSchema,
  /** Сколько других сессий завершено. */
  sessionsRevoked: z.number().int().min(0),
});
export type ChangePasswordResponse = z.infer<typeof changePasswordResponseSchema>;

/* ---------- 2FA ---------- */
export const totpReissueResponseSchema = setupStartResponseSchema;
export type TotpReissueResponse = z.infer<typeof totpReissueResponseSchema>;

export const totpConfirmRequestSchema = z.object({ code: totpCodeSchema });
export type TotpConfirmRequest = z.infer<typeof totpConfirmRequestSchema>;

export const totpConfirmResponseSchema = z.object({
  me: meSchema,
  sessionsRevoked: z.number().int().min(0),
  trustedDevicesRemoved: z.number().int().min(0),
});
export type TotpConfirmResponse = z.infer<typeof totpConfirmResponseSchema>;

/* ---------- коды восстановления ---------- */
export const recoveryRegenerateResponseSchema = z.object({
  recoveryCodes: z.array(z.string()).length(RECOVERY_CODES_TOTAL),
});
export type RecoveryRegenerateResponse = z.infer<typeof recoveryRegenerateResponseSchema>;

/** Повторный показ (GET, step-up): использованные — с датой; code null у кодов старого формата. */
export const recoveryCodesViewSchema = z.object({
  codes: z.array(
    z.object({
      code: z.string().nullable(),
      usedAt: z.iso.datetime({ offset: true }).nullable(),
    }),
  ),
});
export type RecoveryCodesView = z.infer<typeof recoveryCodesViewSchema>;

/* ---------- сессии ---------- */
export const sessionInfoSchema = z.object({
  /** Публичный id (отпечаток) — сам токен сессии наружу не отдаётся. */
  id: z.string().min(8),
  current: z.boolean(),
  createdAt: z.iso.datetime({ offset: true }),
  lastSeenAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  ip: z.string(),
  userAgent: z.string(),
  amr: meSchema.shape.amr,
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const sessionsResponseSchema = z.object({ items: z.array(sessionInfoSchema) });
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

export const revokeResultSchema = z.object({ revoked: z.number().int().min(0) });
export type RevokeResult = z.infer<typeof revokeResultSchema>;

/* ---------- запомненные устройства ---------- */
export const trustedDeviceInfoSchema = z.object({
  id: z.uuid(),
  /** Это устройство (cookie совпала). */
  current: z.boolean(),
  userAgent: z.string(),
  ipPrefix: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  lastUsedAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
});
export type TrustedDeviceInfo = z.infer<typeof trustedDeviceInfoSchema>;

export const trustedDevicesResponseSchema = z.object({ items: z.array(trustedDeviceInfoSchema) });
export type TrustedDevicesResponse = z.infer<typeof trustedDevicesResponseSchema>;

/* ---------- ошибки ---------- */
export const SECURITY_PROBLEM = {
  /** Пароль встречается в утечках (Have I Been Pwned, k-anonymity). */
  passwordPwned: 'https://nodeservice.dev/problems/security/password-pwned',
  /** Нет начатого перевыпуска 2FA или он истёк. */
  totpReissueExpired: 'https://nodeservice.dev/problems/security/totp-reissue-expired',
  /** Нельзя завершить текущую сессию через список — для этого есть «Выйти». */
  currentSession: 'https://nodeservice.dev/problems/security/current-session',
} as const;
