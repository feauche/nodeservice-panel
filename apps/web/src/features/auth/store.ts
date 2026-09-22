import type { Me } from '@nodeservice/shared';
import { create } from 'zustand';

/**
 * Состояние авторизации на клиенте. Источник истины — сервер (cookie-сессия),
 * сюда попадает результат GET /auth/status и /auth/me. Флаги locked и pendingTotp
 * живут в sessionStorage: переживают перезагрузку вкладки, но не её закрытие.
 */
const LOCK_KEY = 'ns-locked';
const PENDING_KEY = 'ns-pending-totp';

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
  /** Экран заблокирован вручную — сессия жива, но нужен пароль. */
  locked: boolean;
  /** Пароль принят, ждём код 2FA (нужно для /login/2fa и /login/recovery). */
  pendingTotp: boolean;
  /** Сколько кодов восстановления осталось (из /me или ответа входа); null — неизвестно. */
  recoveryCodesLeft: number | null;

  hydrate(input: { setupRequired: boolean; authenticated: boolean; me?: Me | null; locked?: boolean }): void;
  setMe(me: Me | null): void;
  setSetupRequired(v: boolean): void;
  setPendingTotp(v: boolean): void;
  setRecoveryCodesLeft(n: number | null): void;
  lock(): void;
  unlock(me?: Me): void;
  signedOut(): void;
}

export const useAuthStore = create<AuthState>()((set) => ({
  me: null,
  setupRequired: false,
  hydrated: false,
  locked: readFlag(LOCK_KEY),
  pendingTotp: readFlag(PENDING_KEY),
  recoveryCodesLeft: null,

  hydrate: ({ setupRequired, authenticated, me, locked }) =>
    set((s) => {
      const nextMe = authenticated ? (me ?? s.me) : null;
      // Заблокировано, если так считает сервер (status.locked / me.locked) ИЛИ эта вкладка (fail-closed:
      // локальную блокировку снимает только /unlock).
      const nextLocked = authenticated ? s.locked || Boolean(locked) : false;
      if (nextLocked !== s.locked) writeFlag(LOCK_KEY, nextLocked);
      return {
        hydrated: true,
        setupRequired,
        me: nextMe,
        locked: nextLocked,
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
  lock: () => {
    writeFlag(LOCK_KEY, true);
    set({ locked: true });
  },
  unlock: (me) => {
    writeFlag(LOCK_KEY, false);
    set((s) => ({ locked: false, me: me ?? s.me }));
  },
  signedOut: () => {
    writeFlag(LOCK_KEY, false);
    writeFlag(PENDING_KEY, false);
    set((s) => ({
      me: null,
      locked: false,
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
