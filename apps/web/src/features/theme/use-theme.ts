import { useSyncExternalStore } from 'react';

import { getTheme, onThemeChange, type ThemeKey } from './theme';

/** Реактивный доступ к текущей теме (theme.ts — императивный источник). */
export function useTheme(): ThemeKey {
  return useSyncExternalStore(onThemeChange, getTheme, () => 'dark');
}
