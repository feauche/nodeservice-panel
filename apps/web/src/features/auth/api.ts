import {
  type AuthStatus,
  authStatusSchema,
  type LoginRequest,
  type LoginResponse,
  loginResponseSchema,
  type Me,
  meSchema,
  type RecoveryLoginRequest,
  type SessionResponse,
  type SetupConfirmRequest,
  type SetupConfirmResponse,
  type SetupStartRequest,
  type SetupStartResponse,
  sessionResponseSchema,
  setupConfirmResponseSchema,
  setupStartResponseSchema,
  type TotpLoginRequest,
  type UnlockRequest,
} from '@nodeservice/shared';

import { api } from '@/lib/api';

/** Типизированные вызовы /api/auth — строго по контракту packages/shared. */
export const authApi = {
  status: (signal?: AbortSignal): Promise<AuthStatus> => api.get('/auth/status', authStatusSchema, signal),
  me: (signal?: AbortSignal): Promise<Me> => api.get('/auth/me', meSchema, signal),

  setupStart: (body: SetupStartRequest): Promise<SetupStartResponse> =>
    api.post('/auth/setup/start', body, setupStartResponseSchema),
  setupConfirm: (body: SetupConfirmRequest): Promise<SetupConfirmResponse> =>
    api.post('/auth/setup/confirm', body, setupConfirmResponseSchema),

  login: (body: LoginRequest): Promise<LoginResponse> => api.post('/auth/login', body, loginResponseSchema),
  loginTotp: (body: TotpLoginRequest): Promise<SessionResponse> =>
    api.post('/auth/login/totp', body, sessionResponseSchema),
  loginRecovery: (body: RecoveryLoginRequest): Promise<SessionResponse> =>
    api.post('/auth/login/recovery', body, sessionResponseSchema),

  unlock: (body: UnlockRequest): Promise<SessionResponse> =>
    api.post('/auth/unlock', body, sessionResponseSchema),
  lock: (): Promise<void> => api.postVoid('/auth/lock'),
  logout: (): Promise<void> => api.postVoid('/auth/logout'),
};
