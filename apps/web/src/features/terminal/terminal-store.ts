import { create } from 'zustand';

/** Один сервер, к которому сейчас открыт (или открывается) терминал. */
export interface TerminalTarget {
  id: string;
  name: string;
  host: string;
  port: number;
  sshUser: string;
}

interface TerminalState {
  /** null — окно закрыто. Открытие нового сервера заменяет текущее (окно одно). */
  server: TerminalTarget | null;
  open: (server: TerminalTarget) => void;
  close: () => void;
}

/**
 * Веб-терминал: одно плавающее окно на всё приложение. Открывается из модалки сервера
 * и из будущей командной палитры; смонтировано в корневом маршруте (SessionHosts), поэтому переход
 * между разделами окно не пересоздаёт.
 */
export const useTerminalStore = create<TerminalState>((set) => ({
  server: null,
  open: (server) => set({ server }),
  close: () => set({ server: null }),
}));
