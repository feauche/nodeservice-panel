import { useSyncExternalStore } from 'react';

/**
 * Свёрнутые домены в «DNS интеграциях» (витрина heartbeat-dns-2026-10, вариант A) — в этом браузере, как группы
 * бокового меню (`ns-menu-groups`): переживают обновление страницы и панели. Хранится список свёрнутых
 * `провайдер:домен`: новый домен или незнакомая строка — развёрнуты, по умолчанию развёрнуто всё.
 */
const KEY = 'ns-dns-zones';
const listeners = new Set<() => void>();

export const dnsZoneKey = (provider: string, zone: string) => `${provider}:${zone}`;

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function parse(raw: string | null): ReadonlySet<string> {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Снимок по строке хранилища: пока строка та же — тот же объект (useSyncExternalStore сравнивает ссылки). */
let cache: { raw: string | null; closed: ReadonlySet<string> } | null = null;
/** Хранилище недоступно (приватный режим): свёрнутые живут в памяти до обновления страницы. */
let memory: ReadonlySet<string> | null = null;
function current(): ReadonlySet<string> {
  if (memory) return memory;
  const raw = readRaw();
  if (cache?.raw !== raw) cache = { raw, closed: parse(raw) };
  return cache.closed;
}

function notify() {
  for (const listener of listeners) listener();
}
function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // Свернули в другой вкладке — здесь тоже.
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY || e.key === null) onChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

/** Какие домены свёрнуты (ключи `dnsZoneKey`). */
export function useClosedDnsZones(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, current, current);
}

export function setDnsZoneClosed(key: string, closed: boolean) {
  const prev = current();
  if (prev.has(key) === closed) return;
  const next = new Set(prev);
  if (closed) next.add(key);
  else next.delete(key);
  try {
    localStorage.setItem(KEY, JSON.stringify([...next]));
    memory = null;
  } catch {
    memory = next;
  }
  notify();
}
