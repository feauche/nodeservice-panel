import { redirect } from '@tanstack/react-router';

/**
 * Поэтапное открытие разделов панели.
 *
 * Панель доводится на реальных серверах поэтапно (план — `_dev/docs/master-plan.md`):
 * R1 открыл «Серверы» (и подпункт «Провайдеры»), R2 — «Обзор» и «Журнал», R3 — «Инциденты», R4 досрочно — «Джарвис», «База знаний» и вкладку «Настройки → Джарвис» (без неё ключ Джарвиса нигде не ввести). Остальные разделы и вкладки настроек остаются закрытыми,
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
  // R4 (досрочно, для чекпоинта): чат Джарвиса, база знаний и настройка ключа Джарвиса.
  '/assistant',
  '/knowledge',
  '/settings',
  '/settings/assistant',
]);

export const LOCKED_HINT =
  'Раздел откроется на своём этапе. Сейчас открыты «Обзор», «Серверы», «Инциденты», «Журнал», «Джарвис», «База знаний» и настройки Джарвиса.';

export function isSectionOpen(to: string): boolean {
  return OPEN_SECTIONS.has(to);
}

/** Для beforeLoad закрытого маршрута: вместо раздела показываем HOME_SECTION. */
export function requireSectionOpen(to: string): void {
  if (!isSectionOpen(to)) throw redirect({ to: HOME_SECTION });
}
