/**
 * Три темы NodeService: графит (по умолчанию), светлая, чёрная.
 * Хранится в localStorage, применяется атрибутом data-ns-theme на <html>.
 */
export const THEMES = [
  { key: 'dark', name: 'Графит', description: 'Тёмная с синим уклоном — по умолчанию' },
  { key: 'light', name: 'Светлая', description: 'Для дневного света' },
  { key: 'black', name: 'Чёрная', description: 'Чистый чёрный, для OLED' },
] as const;

export type ThemeKey = (typeof THEMES)[number]['key'];

const STORAGE_KEY = 'ns-theme';
const listeners = new Set<(t: ThemeKey) => void>();

export function isThemeKey(v: unknown): v is ThemeKey {
  return THEMES.some((t) => t.key === v);
}

export function getTheme(): ThemeKey {
  const attr = document.documentElement.getAttribute('data-ns-theme');
  return isThemeKey(attr) ? attr : 'dark';
}

export function setTheme(key: ThemeKey): void {
  document.documentElement.setAttribute('data-ns-theme', key);
  document.documentElement.style.colorScheme = key === 'light' ? 'light' : 'dark';
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    /* приватный режим — не критично */
  }
  for (const l of listeners) l(key);
}

export function cycleTheme(): void {
  const i = THEMES.findIndex((t) => t.key === getTheme());
  const next = THEMES[(i + 1) % THEMES.length];
  if (next) setTheme(next.key);
}

export function onThemeChange(fn: (t: ThemeKey) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Вызывается до первого рендера, чтобы не мигать «не той» темой. */
export function initTheme(): void {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  setTheme(isThemeKey(saved) ? saved : 'dark');
}
