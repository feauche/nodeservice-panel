import { AUTH_PROBLEM } from '@nodeservice/shared';
import { create } from 'zustand';

import { isApiError } from '@/lib/api';

/**
 * Step-up: сервер отвечает 403 step-up-required, если пароль вводили давно.
 * `withStepUp(fn)` ловит это, просит пароль (диалог StepUpHost, POST /auth/unlock)
 * и повторяет запрос один раз. Диалог один на приложение — очередь запросов сериализуется.
 */
interface StepUpState {
  open: boolean;
  resolve: ((ok: boolean) => void) | null;
  request: () => Promise<boolean>;
  finish: (ok: boolean) => void;
}

export const useStepUpStore = create<StepUpState>((set, get) => ({
  open: false,
  resolve: null,
  request: () =>
    new Promise<boolean>((resolve) => {
      const prev = get().resolve;
      // Второй запрос, пока диалог открыт — ждёт того же ответа.
      set({
        open: true,
        resolve: (ok) => {
          prev?.(ok);
          resolve(ok);
        },
      });
    }),
  finish: (ok) => {
    const { resolve } = get();
    set({ open: false, resolve: null });
    resolve?.(ok);
  },
}));

export function isStepUpError(e: unknown): boolean {
  return isApiError(e) && e.status === 403 && e.type === AUTH_PROBLEM.stepUp;
}

export class StepUpCancelledError extends Error {
  constructor() {
    super('Подтверждение паролем отменено');
    this.name = 'StepUpCancelledError';
  }
}

export async function withStepUp<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isStepUpError(e)) throw e;
    const ok = await useStepUpStore.getState().request();
    if (!ok) throw new StepUpCancelledError();
    return await fn();
  }
}
