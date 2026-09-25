import { create } from 'zustand';

import type { ServerModalTab } from './server-modal';

interface ServerModalState {
  /** Открытая карточка сервера; null — закрыта. */
  serverId: string | null;
  tab: ServerModalTab;
  open: (id: string, tab?: ServerModalTab) => void;
  close: () => void;
}

/**
 * Карточка сервера открывается поверх любой страницы (инцидент, обзор, провайдер, уведомление), не
 * перекидывая в раздел «Серверы»: страница под ней остаётся на месте.
 */
export const useServerModalStore = create<ServerModalState>((set) => ({
  serverId: null,
  tab: 'metrics',
  open: (id, tab = 'metrics') => set({ serverId: id, tab }),
  close: () => set({ serverId: null, tab: 'metrics' }),
}));

/** Открыть карточку сервера отовсюду. */
export const openServer = (id: string, tab: ServerModalTab = 'metrics'): void =>
  useServerModalStore.getState().open(id, tab);

const SERVER_LINK = /^\/servers\?open=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Старые ссылки на сервер (`/servers?open=<id>`, например в уведомлениях) → id для открытия поверх страницы. */
export const serverIdFromLink = (to: string): string | null => SERVER_LINK.exec(to)?.[1] ?? null;
