import { useSyncExternalStore } from 'react';

/** Группы бокового меню, которые можно свернуть (витрина menu-groups-2026-10, вариант A). */
export const NAV_GROUP_IDS = ['manage', 'help', 'integrations', 'sites'] as const;
export type NavGroupId = (typeof NAV_GROUP_IDS)[number];

/**
 * Свёрнутые группы — в этом браузере, как «Свернуть меню» (`ns-rail`): переживают обновление страницы и панели.
 * Хранится список свёрнутых: новая группа или незнакомый id — развёрнуты.
 */
const KEY = 'ns-menu-groups';
const listeners = new Set<() => void>();

function read(): ReadonlySet<NavGroupId> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set(
      Array.isArray(raw)
        ? raw.filter((v): v is NavGroupId => (NAV_GROUP_IDS as readonly unknown[]).includes(v))
        : [],
    );
  } catch {
    return new Set();
  }
}
let snapshot: ReadonlySet<NavGroupId> | null = null;
const current = () => {
  snapshot ??= read();
  return snapshot;
};

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Свернули в другой вкладке — меню здесь тоже.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    snapshot = read();
    onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** Какие группы свёрнуты — общее для бокового меню и выезжающего на телефоне. */
export function useClosedNavGroups(): ReadonlySet<NavGroupId> {
  return useSyncExternalStore(subscribe, current, current);
}

export function toggleNavGroup(id: NavGroupId) {
  const next = new Set(current());
  if (next.has(id)) next.delete(id);
  else next.add(id);
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
  } catch {
    /* Хранилище недоступно (приватный режим) — свёрнуто до обновления страницы. */
  }
  for (const listener of listeners) listener();
}
