import { redirect } from '@tanstack/react-router';

/**
 * Поэтапное открытие разделов панели.
 *
 * Панель доводится на реальных серверах поэтапно (план — `_dev/docs/master-plan.md`):
 * R1 открыл «Серверы» (и подпункт «Провайдеры»), R2 — «Обзор» и «Журнал», R3 — «Инциденты», R4 досрочно — «Ассистент», «База знаний» и вкладку «Настройки → Ассистент» (без неё ключ ассистента нигде не ввести). Остальные разделы и вкладки настроек остаются закрытыми,
 * и недоступны по прямой ссылке: `requireSectionOpen` уводит на HOME_SECTION.
 * Чтобы открыть раздел на его этапе — добавь путь в OPEN_SECTIONS.
 */
export const HOME_SECTION = '/' as const;

export const OPEN_SECTIONS: ReadonlySet<string> = new Set<string>([
  HOME_SECTION,
  '/servers',
  '/servers/providers',
  '/audit',
  '/incidents',
  '/incidents/autofix',
  // R4 (досрочно, для чекпоинта): чат ассистента, база знаний и настройка ключа ассистента.
  '/assistant',
  '/knowledge',
  '/settings',
  '/settings/assistant',
]);

export const LOCKED_HINT =
  'Раздел откроется на своём этапе. Сейчас открыты «Обзор», «Серверы», «Инциденты», «Журнал», «Ассистент», «База знаний» и настройки ассистента.';

export function isSectionOpen(to: string): boolean {
  return OPEN_SECTIONS.has(to);
}

/** Для beforeLoad закрытого маршрута: вместо раздела показываем HOME_SECTION. */
export function requireSectionOpen(to: string): void {
  if (!isSectionOpen(to)) throw redirect({ to: HOME_SECTION });
}
