import { redirect } from '@tanstack/react-router';

/**
 * Поэтапное открытие разделов панели.
 *
 * Пока панель доводится на реальных серверах, открыт только раздел «Серверы»
 * (план — `docs/master-plan.md`). Остальные разделы остаются в меню, но с замком,
 * и недоступны по прямой ссылке: `requireSectionOpen` уводит на HOME_SECTION.
 * Чтобы открыть раздел на его этапе — добавь путь в OPEN_SECTIONS.
 */
export const HOME_SECTION = '/servers' as const;

export const OPEN_SECTIONS: ReadonlySet<string> = new Set<string>([HOME_SECTION]);

export const LOCKED_HINT = 'Раздел откроется на своём этапе. Сейчас в работе — «Серверы».';

export function isSectionOpen(to: string): boolean {
  return OPEN_SECTIONS.has(to);
}

/** Для beforeLoad закрытого маршрута: вместо раздела показываем HOME_SECTION. */
export function requireSectionOpen(to: string): void {
  if (!isSectionOpen(to)) throw redirect({ to: HOME_SECTION });
}
