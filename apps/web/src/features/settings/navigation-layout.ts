import { useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';

export type NavigationLayout = 'sidebar' | 'top';

const STORAGE_KEY = 'ns-navigation-layout';
const EVENT_NAME = 'nodeservice:navigation-layout';
let memoryLayout: NavigationLayout = 'sidebar';

function readLayout(): NavigationLayout {
  try {
    memoryLayout = localStorage.getItem(STORAGE_KEY) === 'top' ? 'top' : 'sidebar';
    return memoryLayout;
  } catch {
    return memoryLayout;
  }
}

function subscribe(onStoreChange: () => void): () => void {
  const notify = () => onStoreChange();
  window.addEventListener(EVENT_NAME, notify);
  window.addEventListener('storage', notify);
  return () => {
    window.removeEventListener(EVENT_NAME, notify);
    window.removeEventListener('storage', notify);
  };
}

export function useNavigationLayout(): NavigationLayout {
  return useSyncExternalStore(subscribe, readLayout, () => 'sidebar');
}

export function setNavigationLayout(layout: NavigationLayout): void {
  memoryLayout = layout;
  try {
    localStorage.setItem(STORAGE_KEY, layout);
  } catch {
    /* Без хранилища выбор всё равно действует до перезагрузки. */
  }
  window.dispatchEvent(new Event(EVENT_NAME));
}

/** Перестраивает каркас одним коротким переходом; системную настройку уменьшения движения уважает. */
export function transitionNavigationLayout(layout: NavigationLayout): void {
  if (layout === readLayout()) return;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const startViewTransition = document.startViewTransition?.bind(document);
  if (reducedMotion) {
    setNavigationLayout(layout);
    return;
  }
  if (!startViewTransition) {
    flushSync(() => setNavigationLayout(layout));
    document.documentElement.animate?.(
      [
        { opacity: 0.82, transform: 'translateY(5px) scale(0.994)' },
        { opacity: 1, transform: 'none' },
      ],
      { duration: 220, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' },
    );
    return;
  }
  startViewTransition(() => {
    flushSync(() => setNavigationLayout(layout));
  });
}

/** Только для тестов. */
export function resetNavigationLayout(): void {
  memoryLayout = 'sidebar';
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(EVENT_NAME));
}
