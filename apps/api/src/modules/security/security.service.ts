import { Inject, Injectable } from '@nestjs/common';
import {
  type ChangePasswordRequest,
  type ChangePasswordResponse,
  RECOVERY_CODES_TOTAL,
  type RecoveryCodesView,
  type RecoveryRegenerateResponse,
  type RevokeResult,
  type SecurityOverview,
  type SecurityPolicy,
  type SecurityPolicyUpdate,
  type SessionsResponse,
  type TotpConfirmResponse,
  type TotpReissueResponse,
  type TrustedDevicesResponse,
} from '@nodeservice/shared';
import type { Redis } from 'ioredis';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { diffChanges } from '../audit/audit.diff.js';
import { AuditService } from '../audit/audit.service.js';
import type { CurrentUserPayload } from '../auth/auth.decorators.js';
import { authProblems } from '../auth/auth.problems.js';
import { AuthService } from '../auth/auth.service.js';
import type { RequestContext } from '../auth/request-context.js';
import { SecurityPolicyStore } from '../auth/security-policy.store.js';
import { type SessionRecord, SessionStore } from '../auth/session.store.js';
import { ThrottleService } from '../auth/throttle.service.js';
import { TotpService } from '../auth/totp.service.js';
import { UsersRepository } from '../auth/users.repository.js';
import { PwnedPasswordsService } from './pwned-passwords.service.js';
import { securityProblems } from './security.problems.js';

/** Сколько живёт начатый перевыпуск 2FA (новый секрет ждёт подтверждения кодом). */
const REISSUE_TTL_MS = 10 * 60_000;
const REISSUE_MAX_ATTEMPTS = 5;
const PUBLIC_ID_LEN = 16;

/**
 * «Безопасность и сессии»: всё, что меняет способ входа или живые сессии.
 * Правило из требований 23.7: смена пароля / перевыпуск 2FA завершают остальные сессии,
 * перевыпуск 2FA ещё и сбрасывает запомненные устройства. Каждое действие — в Журнал.
 */
@Injectable()
export class SecurityService {
  constructor(
    private readonly users: UsersRepository,
    private readonly sessions: SessionStore,
    private readonly totp: TotpService,
    private readonly crypto: CryptoService,
    private readonly throttle: ThrottleService,
    private readonly policy: SecurityPolicyStore,
    private readonly pwned: PwnedPasswordsService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  /* ---------- обзор ---------- */

  async overview(user: CurrentUserPayload): Promise<SecurityOverview> {
    const full = await this.users.findById(user.id);
    if (!full) throw authProblems.unauthenticated();
    const [sessions, devices, recoveryCodesLeft, policy] = await Promise.all([
      this.sessions.listForUser(user.id),
      this.users.listTrustedDevices(user.id),
      this.users.countUnusedRecoveryCodes(user.id),
      this.policy.get(),
    ]);
    return {
      login: full.login,
      passwordChangedAt: full.passwordChangedAt.toISOString(),
      totpConfirmedAt: full.totpConfirmedAt?.toISOString() ?? null,
      recoveryCodesLeft,
      recoveryCodesTotal: RECOVERY_CODES_TOTAL,
      sessionsCount: sessions.length,
      trustedDevicesCount: devices.length,
      policy,
    };
  }

  /* ---------- пароль ---------- */

  async changePassword(
    user: CurrentUserPayload,
    session: SessionRecord,
    body: ChangePasswordRequest,
    ctx: RequestContext,
  ): Promise<ChangePasswordResponse> {
    // Текущий пароль — это и есть step-up; подбор через этот эндпоинт тормозим тем же throttle, что и вход.
    const key = { ip: ctx.ip, login: user.login };
    await this.throttle.assertAllowed(key).catch(async (e: unknown) => {
      await this.audit.record({
        action: 'security.password.changed',
        result: 'denied',
        severity: 'warn',
        metadata: { reason: 'throttled' },
      });
      throw e;
    });
    const full = await this.users.findById(user.id);
    if (!full || !(await this.crypto.verifyPassword(full.passwordHash, body.currentPassword))) {
      await this.audit.record({
        action: 'security.password.changed',
        result: 'failed',
        severity: 'warn',
        metadata: { reason: 'password' },
      });
      await this.throttle.recordFailure(key);
      throw authProblems.invalidCredentials();
    }
    await this.throttle.reset(key);

    if (await this.pwned.isPwned(body.newPassword)) {
      await this.audit.record({
        action: 'security.password.changed',
        result: 'failed',
        severity: 'warn',
        metadata: { reason: 'pwned' },
      });
      throw securityProblems.passwordPwned();
    }

    await this.users.setPassword(user.id, await this.crypto.hashPassword(body.newPassword));
    const sessionsRevoked = await this.sessions.destroyOthersForUser(user.id, session.id);
    const now = new Date();
    await this.sessions.setStepUp(session.id, now);
    session.stepUpAt = now.toISOString();
    await this.audit.record({
      action: 'security.password.changed',
      severity: 'warn',
      metadata: { passwordChanged: true, sessionsRevoked },
    });
    return { me: await this.auth.me(user, session), sessionsRevoked };
  }

  /* ---------- 2FA ---------- */

  private reissueKey(userId: string): string {
    return `sec:totp-reissue:${userId}`;
  }

  /** Новый секрет: показываем QR, в БД пока ничего не меняем — старый код продолжает работать. */
  async totpReissueStart(user: CurrentUserPayload): Promise<TotpReissueResponse> {
    const enrollment = await this.totp.enroll(user.login);
    const key = this.reissueKey(user.id);
    await this.valkey
      .multi()
      .set(key, this.crypto.encrypt(enrollment.secret), 'PX', REISSUE_TTL_MS)
      .del(`${key}:fails`)
      .exec();
    await this.totp.forget(`reissue:${user.id}`);
    // Старт виден в Журнале сам по себе: до подтверждения ничего не меняется, но попытка есть.
    await this.audit.record({ action: 'security.totp.reissue_started' });
    return {
      totpSecret: enrollment.secret,
      otpauthUrl: enrollment.otpauthUrl,
      qrDataUrl: enrollment.qrDataUrl,
    };
  }

  async totpReissueConfirm(
    user: CurrentUserPayload,
    session: SessionRecord,
    code: string,
  ): Promise<TotpConfirmResponse> {
    const key = this.reissueKey(user.id);
    const enc = await this.valkey.get(key);
    if (!enc) throw securityProblems.totpReissueExpired();
    const tmpKey = `reissue:${user.id}`;
    const ok = await this.totp.verify(tmpKey, this.crypto.decrypt(enc), code);
    if (!ok) {
      const fails = await this.valkey.incr(`${key}:fails`);
      await this.valkey.pexpire(`${key}:fails`, REISSUE_TTL_MS);
      if (fails >= REISSUE_MAX_ATTEMPTS) await this.valkey.del(key, `${key}:fails`);
      await this.audit.record({
        action: 'security.totp.reissued',
        result: 'failed',
        severity: 'warn',
        metadata: { reason: 'totp', attempts: fails },
      });
      throw fails >= REISSUE_MAX_ATTEMPTS
        ? securityProblems.totpReissueExpired()
        : authProblems.invalidTotp();
    }

    await this.users.replaceTotp(user.id, enc, this.crypto.currentKeyVersion, new Date());
    await this.totp.adopt(tmpKey, user.id);
    await this.valkey.del(key, `${key}:fails`);
    const trustedDevicesRemoved = (await this.users.listTrustedDevices(user.id)).length;
    await this.users.deleteTrustedDevices(user.id);
    const sessionsRevoked = await this.sessions.destroyOthersForUser(user.id, session.id);
    await this.audit.record({
      action: 'security.totp.reissued',
      severity: 'warn',
      metadata: { sessionsRevoked, trustedDevicesRemoved },
    });
    return { me: await this.auth.me(user, session), sessionsRevoked, trustedDevicesRemoved };
  }

  /* ---------- коды восстановления ---------- */

  /** Повторный показ: расшифровываем копии; факт просмотра — в Журнал. */
  async viewRecoveryCodes(user: CurrentUserPayload): Promise<RecoveryCodesView> {
    const rows = await this.users.listRecoveryCodes(user.id);
    const codes = rows.map((r) => ({
      code: r.codeEnc ? this.crypto.decrypt(r.codeEnc) : null,
      usedAt: r.usedAt?.toISOString() ?? null,
    }));
    await this.audit.record({
      action: 'security.recovery_codes.viewed',
      severity: 'warn',
      metadata: { total: codes.length, used: codes.filter((c) => c.usedAt).length },
    });
    return { codes };
  }

  async regenerateRecoveryCodes(user: CurrentUserPayload): Promise<RecoveryRegenerateResponse> {
    const codes = await this.auth.issueRecoveryCodes(user.id);
    await this.audit.record({
      action: 'security.recovery_codes.regenerated',
      severity: 'warn',
      metadata: { count: codes.length },
    });
    return { recoveryCodes: codes };
  }

  /* ---------- сессии ---------- */

  /** Наружу — отпечаток, а не сам токен сессии. */
  publicSessionId(sid: string): string {
    return this.crypto.sha256Hex(sid).slice(0, PUBLIC_ID_LEN);
  }

  async listSessions(user: CurrentUserPayload, session: SessionRecord): Promise<SessionsResponse> {
    const rows = await this.sessions.listForUser(user.id);
    return {
      items: rows.map((s) => ({
        id: this.publicSessionId(s.id),
        current: s.id === session.id,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
        expiresAt: s.absoluteExpiresAt,
        ip: s.ip,
        userAgent: s.ua,
        amr: s.amr,
      })),
    };
  }

  async revokeSession(
    user: CurrentUserPayload,
    session: SessionRecord,
    publicId: string,
  ): Promise<RevokeResult> {
    const rows = await this.sessions.listForUser(user.id);
    const target = rows.find((s) => this.publicSessionId(s.id) === publicId);
    if (!target) return { revoked: 0 };
    if (target.id === session.id) throw securityProblems.currentSession();
    await this.sessions.destroy(target.id);
    await this.audit.record({
      action: 'security.session.revoked',
      target: { type: 'session', id: publicId, display: target.ua.slice(0, 80) || target.ip },
      metadata: { sessionIp: target.ip, sessionCreatedAt: target.createdAt },
    });
    return { revoked: 1 };
  }

  async revokeOtherSessions(user: CurrentUserPayload, session: SessionRecord): Promise<RevokeResult> {
    const revoked = await this.sessions.destroyOthersForUser(user.id, session.id);
    await this.audit.record({
      action: 'security.sessions.revoked_others',
      metadata: { sessionsRevoked: revoked },
    });
    return { revoked };
  }

  /* ---------- запомненные устройства ---------- */

  async listTrustedDevices(user: CurrentUserPayload, trustedToken?: string): Promise<TrustedDevicesResponse> {
    const currentHash = trustedToken ? this.crypto.sha256Hex(trustedToken) : null;
    const rows = await this.users.listTrustedDevices(user.id);
    return {
      items: rows.map((d) => ({
        id: d.id,
        current: d.tokenHash === currentHash,
        userAgent: d.userAgent,
        ipPrefix: d.ipPrefix,
        createdAt: d.createdAt.toISOString(),
        lastUsedAt: d.lastUsedAt.toISOString(),
        expiresAt: d.expiresAt.toISOString(),
      })),
    };
  }

  /** Возвращает, было ли удалённое устройство текущим (контроллер тогда стирает cookie). */
  async removeTrustedDevice(
    user: CurrentUserPayload,
    id: string,
    trustedToken?: string,
  ): Promise<RevokeResult & { current: boolean }> {
    const rows = await this.users.listTrustedDevices(user.id);
    const target = rows.find((d) => d.id === id);
    if (!target) return { revoked: 0, current: false };
    await this.users.deleteTrustedDevice(id);
    const current = Boolean(trustedToken) && target.tokenHash === this.crypto.sha256Hex(trustedToken ?? '');
    await this.audit.record({
      action: 'security.trusted_device.removed',
      target: { type: 'trusted_device', id, display: target.userAgent.slice(0, 80) || target.ipPrefix },
      metadata: { ipPrefix: target.ipPrefix, current },
    });
    return { revoked: 1, current };
  }

  async clearTrustedDevices(user: CurrentUserPayload): Promise<RevokeResult> {
    const revoked = (await this.users.listTrustedDevices(user.id)).length;
    await this.users.deleteTrustedDevices(user.id);
    await this.audit.record({
      action: 'security.trusted_devices.cleared',
      metadata: { trustedDevicesRemoved: revoked },
    });
    return { revoked };
  }

  /* ---------- политика ---------- */

  getPolicy(): Promise<SecurityPolicy> {
    return this.policy.get();
  }

  async updatePolicy(patch: SecurityPolicyUpdate): Promise<SecurityPolicy> {
    const { before, after } = await this.policy.set(patch);
    await this.audit.record({
      action: 'security.policy.updated',
      target: { type: 'settings', id: 'security', display: 'Политика безопасности' },
      changes: diffChanges(before, after),
    });
    return after;
  }
}
