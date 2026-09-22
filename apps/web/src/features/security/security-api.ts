import {
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  changePasswordResponseSchema,
  type RecoveryCodesView,
  type RecoveryRegenerateResponse,
  type RevokeResult,
  recoveryCodesViewSchema,
  recoveryRegenerateResponseSchema,
  revokeResultSchema,
  type SecurityOverview,
  type SecurityPolicy,
  type SecurityPolicyUpdate,
  type SessionsResponse,
  securityOverviewSchema,
  securityPolicySchema,
  sessionsResponseSchema,
  type TotpConfirmResponse,
  type TotpReissueResponse,
  type TrustedDevicesResponse,
  totpConfirmResponseSchema,
  totpReissueResponseSchema,
  trustedDevicesResponseSchema,
} from '@nodeservice/shared';
import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { applySession } from '@/features/auth/queries';
import { api, request } from '@/lib/api';
import { withStepUp } from './step-up';

/** /api/security — строго по контракту packages/shared/src/security.ts. */
export const securityApi = {
  overview: (signal?: AbortSignal): Promise<SecurityOverview> =>
    api.get('/security/overview', securityOverviewSchema, signal),
  changePassword: (body: ChangePasswordRequest): Promise<ChangePasswordResponse> =>
    api.post('/security/password', body, changePasswordResponseSchema),
  totpReissue: (): Promise<TotpReissueResponse> =>
    api.post('/security/totp/reissue', {}, totpReissueResponseSchema),
  totpConfirm: (code: string): Promise<TotpConfirmResponse> =>
    api.post('/security/totp/confirm', { code }, totpConfirmResponseSchema),
  viewRecoveryCodes: (): Promise<RecoveryCodesView> =>
    api.get('/security/recovery-codes', recoveryCodesViewSchema),
  regenerateRecoveryCodes: (): Promise<RecoveryRegenerateResponse> =>
    api.post('/security/recovery-codes', {}, recoveryRegenerateResponseSchema),
  sessions: (signal?: AbortSignal): Promise<SessionsResponse> =>
    api.get('/security/sessions', sessionsResponseSchema, signal),
  revokeSession: (id: string): Promise<RevokeResult> =>
    request(`/security/sessions/${id}`, { method: 'DELETE', schema: revokeResultSchema }),
  revokeOthers: (): Promise<RevokeResult> =>
    api.post('/security/sessions/revoke-others', {}, revokeResultSchema),
  trustedDevices: (signal?: AbortSignal): Promise<TrustedDevicesResponse> =>
    api.get('/security/trusted-devices', trustedDevicesResponseSchema, signal),
  removeTrustedDevice: (id: string): Promise<RevokeResult> =>
    request(`/security/trusted-devices/${id}`, { method: 'DELETE', schema: revokeResultSchema }),
  clearTrustedDevices: (): Promise<RevokeResult> =>
    api.post('/security/trusted-devices/clear', {}, revokeResultSchema),
  updatePolicy: (patch: SecurityPolicyUpdate): Promise<SecurityPolicy> =>
    api.put('/security/policy', patch, securityPolicySchema),
};

export const securityKeys = {
  all: ['security'] as const,
  overview: ['security', 'overview'] as const,
  sessions: ['security', 'sessions'] as const,
  devices: ['security', 'trusted-devices'] as const,
};

export const securityOverviewQuery = queryOptions({
  queryKey: securityKeys.overview,
  queryFn: ({ signal }) => securityApi.overview(signal),
  staleTime: 60_000,
});

export function useSecurityOverview() {
  return useQuery(securityOverviewQuery);
}

export function useSessions() {
  return useQuery({
    queryKey: securityKeys.sessions,
    queryFn: ({ signal }) => securityApi.sessions(signal),
    staleTime: 15_000,
  });
}

export function useTrustedDevices() {
  return useQuery({
    queryKey: securityKeys.devices,
    queryFn: ({ signal }) => securityApi.trustedDevices(signal),
    staleTime: 15_000,
  });
}

function useInvalidateSecurity() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: securityKeys.all });
}

export function useChangePassword() {
  const qc = useQueryClient();
  const invalidate = useInvalidateSecurity();
  return useMutation({
    mutationFn: securityApi.changePassword,
    onSuccess: (res) => {
      applySession(qc, res.me);
      void invalidate();
    },
  });
}

/** Шаг 1 перевыпуска — за step-up. */
export function useTotpReissue() {
  return useMutation({ mutationFn: () => withStepUp(() => securityApi.totpReissue()) });
}

export function useTotpConfirm() {
  const qc = useQueryClient();
  const invalidate = useInvalidateSecurity();
  return useMutation({
    mutationFn: securityApi.totpConfirm,
    onSuccess: (res) => {
      applySession(qc, res.me);
      void invalidate();
    },
  });
}

/** Повторный показ — за step-up; просмотр пишется в Журнал. */
export function useViewRecoveryCodes() {
  return useMutation({ mutationFn: () => withStepUp(() => securityApi.viewRecoveryCodes()) });
}

export function useRegenerateRecoveryCodes() {
  const qc = useQueryClient();
  const invalidate = useInvalidateSecurity();
  return useMutation({
    mutationFn: () => withStepUp(() => securityApi.regenerateRecoveryCodes()),
    onSuccess: () => {
      void invalidate();
      void qc.invalidateQueries({ queryKey: ['auth'] });
    },
  });
}

export function useRevokeSession() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: securityApi.revokeSession, onSuccess: () => void invalidate() });
}

export function useRevokeOthers() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: securityApi.revokeOthers, onSuccess: () => void invalidate() });
}

export function useRemoveTrustedDevice() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: securityApi.removeTrustedDevice, onSuccess: () => void invalidate() });
}

export function useClearTrustedDevices() {
  const invalidate = useInvalidateSecurity();
  return useMutation({ mutationFn: securityApi.clearTrustedDevices, onSuccess: () => void invalidate() });
}

export function useUpdatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SecurityPolicyUpdate) => withStepUp(() => securityApi.updatePolicy(patch)),
    onSuccess: (policy) => {
      qc.setQueryData<SecurityOverview>(securityKeys.overview, (old) => (old ? { ...old, policy } : old));
    },
  });
}
