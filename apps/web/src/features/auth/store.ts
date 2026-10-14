import type { LockReason, Me } from '@nodeservice/shared';
import { create } from 'zustand';

/**
 * Состояние авторизации на клиенте. Источник истины — сервер (cookie-сессия),
 * сюда попадает результат GET /auth/status и /auth/me. Флаги locked и pendingTotp
 * живут в sessionStorage: переживают перезагрузку вкладки, но не её закрытие.
 */
const LOCK_KEY = 'ns-locked';
const LOCK_INFO_KEY = 'ns-lock-reason';
const PENDING_KEY = 'ns-pending-totp';

/** Почему эта вкладка заблокировала экран сама: вручную или по бездействию (через сколько минут). */
export interface LockInfo {
  reason: LockReason;
  minutes: number | null;
}

function readLockInfo(): LockInfo | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(LOCK_INFO_KEY) ?? 'null') as Partial<LockInfo> | null;
    if (parsed?.reason !== 'manual' && parsed?.reason !== 'idle') return null;
    return { reason: parsed.reason, minutes: typeof parsed.minutes === 'number' ? parsed.minutes : null };
  } catch {
    return null;
  }
}

function writeLockInfo(info: LockInfo | null): void {
  try {
    if (info) sessionStorage.setItem(LOCK_INFO_KEY, JSON.stringify(info));
    else sessionStorage.removeItem(LOCK_INFO_KEY);
  } catch {
    /* приватный режим — причину спросим у сервера */
  }
}

function readFlag(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch {
    /* приватный режим — не критично */
  }
}

export interface AuthState {
  /** Текущий администратор; null — сессии нет или ещё не загружали. */
  me: Me | null;
  /** Нужен мастер первого запуска. */
  setupRequired: boolean;
  /** Статус уже получен с сервера хотя бы раз. */
  hydrated: boolean;
  /** Экран заблокирован (вручную, по бездействию или сервером) — сессия жива, но нужен пароль. */
  locked: boolean;
  /** Почему заблокировала эта вкладка; null — заблокировал сервер или другая вкладка (причина — в me). */
  lockInfo: LockInfo | null;
  /** Пароль принят, ждём код 2FA (нужно для /login/2fa и /login/recovery). */
  pendingTotp: boolean;
  /** Сколько кодов восстановления осталось (из /me или ответа входа); null — неизвестно. */
  recoveryCodesLeft: number | null;

  hydrate(input: { setupRequired: boolean; authenticated: boolean; me?: Me | null; locked?: boolean }): void;
  setMe(me: Me | null): void;
  setSetupRequired(v: boolean): void;
  setPendingTotp(v: boolean): void;
  setRecoveryCodesLeft(n: number | null): void;
  lock(info?: LockInfo): void;
  unlock(me?: Me): void;
  signedOut(): void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  me: null,
  setupRequired: false,
  hydrated: false,
  locked: readFlag(LOCK_KEY),
  lockInfo: readFlag(LOCK_KEY) ? readLockInfo() : null,
  pendingTotp: readFlag(PENDING_KEY),
  recoveryCodesLeft: null,

  hydrate: ({ setupRequired, authenticated, me, locked }) =>
    set((s) => {
      const nextMe = authenticated ? (me ?? s.me) : null;
      // Заблокировано, если так считает сервер (status.locked / me.locked) ИЛИ эта вкладка (fail-closed:
      // локальную блокировку снимает только /unlock).
      const nextLocked = authenticated ? s.locked || Boolean(locked) : false;
      if (nextLocked !== s.locked) writeFlag(LOCK_KEY, nextLocked);
      if (!nextLocked && s.lockInfo) writeLockInfo(null);
      return {
        hydrated: true,
        setupRequired,
        me: nextMe,
        locked: nextLocked,
        lockInfo: nextLocked ? s.lockInfo : null,
        recoveryCodesLeft: nextMe ? nextMe.recoveryCodesLeft : s.recoveryCodesLeft,
      };
    }),
  setMe: (me) => set((s) => ({ me, recoveryCodesLeft: me ? me.recoveryCodesLeft : s.recoveryCodesLeft })),
  setRecoveryCodesLeft: (recoveryCodesLeft) => set({ recoveryCodesLeft }),
  setSetupRequired: (setupRequired) => set({ setupRequired }),
  setPendingTotp: (pendingTotp) => {
    writeFlag(PENDING_KEY, pendingTotp);
    set({ pendingTotp });
  },
  lock: (info) => {
    writeFlag(LOCK_KEY, true);
    writeLockInfo(info ?? null);
    set({ locked: true, lockInfo: info ?? null });
  },
  unlock: (me) => {
    writeFlag(LOCK_KEY, false);
    writeLockInfo(null);
    set((s) => ({ locked: false, lockInfo: null, me: me ?? s.me }));
  },
  signedOut: () => {
    writeFlag(LOCK_KEY, false);
    writeLockInfo(null);
    writeFlag(PENDING_KEY, false);
    set((s) => ({
      me: null,
      locked: false,
      lockInfo: null,
      pendingTotp: false,
      hydrated: true,
      recoveryCodesLeft: s.recoveryCodesLeft,
    }));
  },
}));

/** Инициалы для аватара: первые две буквы логина. */
export function initialsOf(login: string | undefined): string {
  const s = (login ?? '').replace(/[^\p{L}\p{N}]/gu, '');
  return (s.slice(0, 2) || 'NS').toUpperCase();
}
