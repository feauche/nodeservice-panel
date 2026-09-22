import { randomInt } from 'node:crypto';
import { type HttpException, Injectable } from '@nestjs/common';
import {
  type LoginResponse,
  type Me,
  RECOVERY_CODES_COUNT,
  type SessionResponse,
  type SetupConfirmResponse,
  type SetupStartResponse,
  TRUSTED_DEVICE_DAYS,
  TRUSTED_DEVICE_MAX,
} from '@nodeservice/shared';

import { CryptoService } from '../../common/crypto/crypto.service.js';
import type { UserRow } from '../../infra/db/schema/index.js';
import { authProblems } from './auth.problems.js';
import { AuthEventsService } from './auth-events.service.js';
import {
  PENDING_LOGIN_TTL_MS,
  PENDING_MAX_ATTEMPTS,
  PENDING_SETUP_TTL_MS,
  PendingStore,
} from './pending.store.js';
import { ipPrefix, type RequestContext } from './request-context.js';
import { SecurityPolicyStore } from './security-policy.store.js';
import { type SessionRecord, SessionStore } from './session.store.js';
import { SetupService } from './setup.service.js';
import { ThrottleService } from './throttle.service.js';
import { TotpService } from './totp.service.js';
import { normalizeLogin, UsersRepository } from './users.repository.js';

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TRUSTED_DEVICE_TTL_MS = TRUSTED_DEVICE_DAYS * 24 * 3_600_000;

/** Что контроллер должен сделать с cookie после операции. */
export interface CookieActions {
  setSession?: string;
  clearSession?: boolean;
  setPending?: string;
  setPendingTtlMs?: number;
  clearPending?: boolean;
  setTrusted?: string;
  clearTrusted?: boolean;
}

export interface AuthResult<T> {
  body: T;
  cookies: CookieActions;
}

const COOKIE_ACTIONS = Symbol('cookieActions');

/** Ошибка, после которой контроллер всё равно должен изменить cookie (например, стереть pending). */
export function withCookies<E extends HttpException>(err: E, cookies: CookieActions): E {
  return Object.assign(err, { [COOKIE_ACTIONS]: cookies });
}

export function cookieActionsOf(err: unknown): CookieActions | undefined {
  return (err as { [COOKIE_ACTIONS]?: CookieActions } | null)?.[COOKIE_ACTIONS];
}

export type UserSummary = Pick<UserRow, 'id' | 'login' | 'createdAt'>;

export function toMe(user: UserSummary, session: SessionRecord, recoveryCodesLeft: number): Me {
  return {
    id: user.id,
    login: user.login,
    amr: session.amr,
    createdAt: user.createdAt.toISOString(),
    stepUpAt: session.stepUpAt,
    recoveryCodesLeft,
    locked: session.lockedAt !== null,
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersRepository,
    private readonly crypto: CryptoService,
    private readonly sessions: SessionStore,
    private readonly pending: PendingStore,
    private readonly throttle: ThrottleService,
    private readonly totp: TotpService,
    private readonly setup: SetupService,
    private readonly events: AuthEventsService,
    private readonly policy: SecurityPolicyStore,
  ) {}

  /* ---------- первый запуск ---------- */

  /** Пользователя в БД пока не создаём: всё лежит в pending (Valkey, 10 мин) до подтверждения кода. */
  async setupStart(
    input: { setupToken: string; login: string; password: string },
    ctx: RequestContext,
  ): Promise<AuthResult<SetupStartResponse>> {
    if (!(await this.setup.isSetupRequired())) throw authProblems.setupDone();
    const tokenId = await this.setup.validateToken(input.setupToken);
    if (!tokenId) {
      await this.events.record('auth.login.failed', {
        ...ctx,
        login: input.login,
        meta: { reason: 'setup-token' },
      });
      throw authProblems.setupToken();
    }
    const login = normalizeLogin(input.login);
    const enrollment = await this.totp.enroll(login);
    const pendingToken = await this.pending.create(
      {
        kind: 'setup',
        setupTokenId: tokenId,
        login,
        passwordHash: await this.crypto.hashPassword(input.password),
        totpSecretEnc: this.crypto.encrypt(enrollment.secret),
        totpKeyVersion: this.crypto.currentKeyVersion,
        ip: ctx.ip,
        ua: ctx.ua,
      },
      PENDING_SETUP_TTL_MS,
    );
    return {
      body: {
        totpSecret: enrollment.secret,
        otpauthUrl: enrollment.otpauthUrl,
        qrDataUrl: enrollment.qrDataUrl,
      },
      cookies: { setPending: pendingToken, setPendingTtlMs: PENDING_SETUP_TTL_MS },
    };
  }

  /** Код подошёл → одна транзакция: пользователь + коды восстановления + setup-токен использован. */
  async setupConfirm(
    pendingToken: string | undefined,
    code: string,
    ctx: RequestContext,
  ): Promise<AuthResult<SetupConfirmResponse>> {
    const pending = await this.pending.get(pendingToken, 'setup');
    if (!pending || !pendingToken) throw authProblems.totpRequired();
    if (!(await this.setup.isSetupRequired())) {
      await this.pending.consume(pendingToken);
      throw withCookies(authProblems.setupDone(), { clearPending: true });
    }

    const tmpKey = setupTotpKey(pending.login);
    const ok = await this.totp.verify(tmpKey, this.crypto.decrypt(pending.totpSecretEnc), code);
    if (!ok) {
      await this.events.record('auth.totp.failed', {
        ...ctx,
        login: pending.login,
        meta: { stage: 'setup' },
      });
      throw await this.failPendingAttempt(pendingToken, pending.login, ctx, authProblems.invalidTotp());
    }

    const now = new Date();
    const codes = generateRecoveryCodes();
    const entries = await this.recoveryEntries(codes);
    const user = await this.users.createConfirmedAdmin({
      login: pending.login,
      passwordHash: pending.passwordHash,
      totpSecretEnc: pending.totpSecretEnc,
      totpKeyVersion: pending.totpKeyVersion,
      confirmedAt: now,
      recoveryCodes: entries,
    });
    await this.pending.consume(pendingToken);
    if (!user) throw withCookies(authProblems.setupDone(), { clearPending: true });
    // Память anti-replay с временного ключа переезжает на настоящий id.
    await this.totp.adopt(tmpKey, user.id);

    const session = await this.sessions.create({
      userId: user.id,
      ua: ctx.ua,
      ip: ctx.ip,
      amr: ['pwd', 'totp'],
    });
    await this.events.record('auth.setup.completed', {
      ...ctx,
      userId: user.id,
      login: user.login,
      amr: session.amr,
    });
    return { body: { recoveryCodes: codes }, cookies: { setSession: session.id, clearPending: true } };
  }

  /* ---------- вход ---------- */

  async login(
    input: { login: string; password: string },
    trustedToken: string | undefined,
    ctx: RequestContext,
  ): Promise<AuthResult<LoginResponse>> {
    const key = { ip: ctx.ip, login: input.login };
    await this.throttle.assertAllowed(key).catch(async (e: unknown) => {
      await this.events.record('auth.login.throttled', { ...ctx, login: input.login });
      throw e;
    });

    const user = await this.users.findByLogin(input.login);
    const ok = user
      ? await this.crypto.verifyPassword(user.passwordHash, input.password)
      : await this.crypto.verifyAgainstDummy(input.password);
    if (!user || !ok) {
      await this.events.record('auth.login.failed', {
        ...ctx,
        login: input.login,
        meta: { reason: 'credentials' },
      });
      await this.throttle.recordFailure(key).catch(async (e: unknown) => {
        await this.events.record('auth.login.throttled', { ...ctx, login: input.login });
        throw e;
      });
      throw authProblems.invalidCredentials();
    }
    await this.throttle.reset(key);

    // Доверенное устройство: пропускаем TOTP — если политика не требует код всегда.
    const alwaysAskTotp = (await this.policy.get()).alwaysAskTotp;
    const device =
      trustedToken && !alwaysAskTotp
        ? await this.users.findTrustedDevice(this.crypto.sha256Hex(trustedToken))
        : undefined;
    if (device && device.userId === user.id && device.expiresAt.getTime() > Date.now()) {
      await this.users.touchTrustedDevice(device.id);
      const session = await this.sessions.create({
        userId: user.id,
        ua: ctx.ua,
        ip: ctx.ip,
        amr: ['pwd', 'trusted'],
      });
      await this.events.record('auth.login.success', {
        ...ctx,
        userId: user.id,
        login: user.login,
        amr: session.amr,
      });
      return {
        body: { next: 'done', me: await this.me(user, session) },
        cookies: { setSession: session.id, clearPending: true },
      };
    }
    const cookies: CookieActions = {};
    if (device && device.userId !== user.id) cookies.clearTrusted = true;
    if (device && device.expiresAt.getTime() <= Date.now()) {
      await this.users.deleteTrustedDevice(device.id);
      cookies.clearTrusted = true;
    }

    // 2FA не настроена (например, отключена через CLI) — впускаем по паролю.
    if (!user.totpSecretEnc || !user.totpConfirmedAt) {
      const session = await this.sessions.create({ userId: user.id, ua: ctx.ua, ip: ctx.ip, amr: ['pwd'] });
      await this.events.record('auth.login.success', {
        ...ctx,
        userId: user.id,
        login: user.login,
        amr: session.amr,
      });
      return {
        body: { next: 'done', me: await this.me(user, session) },
        cookies: { ...cookies, setSession: session.id },
      };
    }

    const pendingToken = await this.pending.create(
      { kind: 'login', userId: user.id, login: user.login, ip: ctx.ip, ua: ctx.ua },
      PENDING_LOGIN_TTL_MS,
    );
    return {
      body: { next: 'totp' },
      cookies: { ...cookies, setPending: pendingToken, setPendingTtlMs: PENDING_LOGIN_TTL_MS },
    };
  }

  async loginTotp(
    pendingToken: string | undefined,
    input: { code: string; rememberDevice: boolean },
    ctx: RequestContext,
  ): Promise<AuthResult<SessionResponse>> {
    const { token, user } = await this.requirePendingLogin(pendingToken);
    if (!user.totpSecretEnc) throw authProblems.totpRequired();

    const ok = await this.totp.verify(user.id, this.crypto.decrypt(user.totpSecretEnc), input.code);
    if (!ok) {
      await this.events.record('auth.totp.failed', { ...ctx, userId: user.id, login: user.login });
      throw await this.failPendingAttempt(token, user.login, ctx, authProblems.invalidTotp(), user.id);
    }
    await this.pending.consume(token);

    const session = await this.sessions.create({
      userId: user.id,
      ua: ctx.ua,
      ip: ctx.ip,
      amr: ['pwd', 'totp'],
    });
    const cookies: CookieActions = { setSession: session.id, clearPending: true };
    if (input.rememberDevice) {
      const token = this.crypto.randomToken(32);
      await this.users.addTrustedDevice(
        {
          userId: user.id,
          tokenHash: this.crypto.sha256Hex(token),
          userAgent: ctx.ua.slice(0, 512),
          ipPrefix: ipPrefix(ctx.ip),
          expiresAt: new Date(Date.now() + TRUSTED_DEVICE_TTL_MS),
        },
        TRUSTED_DEVICE_MAX,
      );
      cookies.setTrusted = token;
      await this.events.record('auth.trusted_device.added', { ...ctx, userId: user.id, login: user.login });
    }
    await this.events.record('auth.login.success', {
      ...ctx,
      userId: user.id,
      login: user.login,
      amr: session.amr,
    });
    return { body: { me: await this.me(user, session) }, cookies };
  }

  async loginRecovery(
    pendingToken: string | undefined,
    code: string,
    ctx: RequestContext,
  ): Promise<AuthResult<SessionResponse>> {
    const { token, user } = await this.requirePendingLogin(pendingToken);

    const normalized = normalizeRecoveryCode(code);
    let matchedId: string | null = null;
    for (const row of await this.users.listUnusedRecoveryCodes(user.id)) {
      if (await this.crypto.verifyRecoveryCode(row.codeHash, normalized)) {
        matchedId = row.id;
        break;
      }
    }
    if (!matchedId) {
      await this.events.record('auth.login.failed', {
        ...ctx,
        userId: user.id,
        login: user.login,
        meta: { reason: 'recovery' },
      });
      throw await this.failPendingAttempt(token, user.login, ctx, authProblems.invalidRecovery(), user.id);
    }
    await this.users.markRecoveryCodeUsed(matchedId);
    // Код восстановления = потеря второго фактора: доверенные устройства больше не доверенные,
    // все остальные сессии завершаются (вдруг вторым фактором уже пользуется кто-то чужой).
    await this.users.deleteTrustedDevices(user.id);
    const revoked = await this.sessions.destroyAllForUser(user.id);
    await this.pending.consume(token);

    const session = await this.sessions.create({
      userId: user.id,
      ua: ctx.ua,
      ip: ctx.ip,
      amr: ['pwd', 'recovery'],
    });
    const recoveryCodesLeft = await this.users.countUnusedRecoveryCodes(user.id);
    await this.events.record('auth.recovery.used', {
      ...ctx,
      userId: user.id,
      login: user.login,
      amr: session.amr,
      meta: { recoveryCodesLeft, sessionsRevoked: revoked },
    });
    return {
      body: { me: toMe(user, session, recoveryCodesLeft), recoveryCodesLeft },
      cookies: { setSession: session.id, clearPending: true, clearTrusted: true },
    };
  }

  /* ---------- в сессии ---------- */

  async unlock(
    user: UserSummary,
    session: SessionRecord,
    password: string,
    ctx: RequestContext,
  ): Promise<SessionResponse> {
    const key = { ip: ctx.ip, login: user.login };
    await this.throttle.assertAllowed(key);
    const full = await this.users.findById(user.id);
    if (!full || !(await this.crypto.verifyPassword(full.passwordHash, password))) {
      await this.events.record('auth.login.failed', {
        ...ctx,
        userId: user.id,
        login: user.login,
        meta: { reason: 'unlock' },
      });
      await this.throttle.recordFailure(key);
      throw authProblems.invalidCredentials();
    }
    await this.throttle.reset(key);
    const now = new Date();
    await this.sessions.setStepUp(session.id, now);
    await this.sessions.setLocked(session.id, null);
    session.stepUpAt = now.toISOString();
    session.lockedAt = null;
    await this.events.record('auth.unlock', { ...ctx, userId: user.id, login: user.login, amr: session.amr });
    return { me: await this.me(user, session) };
  }

  /** Заблокировать экран на сервере: до /unlock остальные запросы получают 403 locked. Идемпотентно. */
  async lock(user: UserSummary, session: SessionRecord, ctx: RequestContext): Promise<void> {
    if (session.lockedAt) return;
    const now = new Date();
    await this.sessions.setLocked(session.id, now);
    session.lockedAt = now.toISOString();
    await this.events.record('auth.lock', { ...ctx, userId: user.id, login: user.login, amr: session.amr });
  }

  /** Me с актуальным числом кодов восстановления. */
  async me(user: UserSummary, session: SessionRecord): Promise<Me> {
    return toMe(user, session, await this.users.countUnusedRecoveryCodes(user.id));
  }

  async logout(session: SessionRecord | undefined, ctx: RequestContext): Promise<void> {
    if (!session) return;
    await this.sessions.destroy(session.id);
    await this.events.record('auth.logout', { ...ctx, userId: session.userId, amr: session.amr });
  }

  /* ---------- helpers ---------- */

  private async requirePendingLogin(token: string | undefined) {
    const pending = await this.pending.get(token, 'login');
    if (!pending || !token) throw authProblems.totpRequired();
    const user = await this.users.findById(pending.userId);
    if (!user) throw authProblems.totpRequired();
    return { token, pending, user };
  }

  /**
   * Неудача на шаге кода: свой счётчик в pending. На PENDING_MAX_ATTEMPTS-й — pending сгорает,
   * cookie стирается, клиент получает totpRequired и возвращается к паролю (там свой throttle).
   */
  private async failPendingAttempt(
    token: string,
    login: string,
    ctx: RequestContext,
    problem: HttpException,
    userId?: string,
  ): Promise<never> {
    const attempts = await this.pending.recordFailure(token);
    if (attempts === 0 || attempts >= PENDING_MAX_ATTEMPTS) {
      await this.pending.consume(token);
      await this.events.record('auth.login.throttled', {
        ...ctx,
        login,
        ...(userId ? { userId } : {}),
        meta: { stage: 'code', attempts },
      });
      throw withCookies(authProblems.totpRequired(), { clearPending: true });
    }
    throw problem;
  }

  /** Перевыпуск: 10 кодов XXXXX-XXXXX; в БД — argon2-хеш + шифрованная копия (для повторного показа). */
  async issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await this.users.replaceRecoveryCodes(userId, await this.recoveryEntries(codes));
    return codes;
  }

  private recoveryEntries(codes: string[]) {
    return Promise.all(
      codes.map(async (c, position) => ({
        codeHash: await this.crypto.hashRecoveryCode(c),
        codeEnc: this.crypto.encrypt(c),
        position,
      })),
    );
  }
}

/** Ключ anti-replay для TOTP в мастере, пока у пользователя нет id. */
function setupTotpKey(login: string): string {
  return `setup:${login}`;
}

export function generateRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODES_COUNT }, generateRecoveryCode);
}

export function generateRecoveryCode(): string {
  const pick = (): string => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)] ?? 'A';
  const part = (): string => Array.from({ length: 5 }, pick).join('');
  return `${part()}-${part()}`;
}

/** «k7qfm2m9xt» → «K7QFM-2M9XT». */
export function normalizeRecoveryCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`;
}
