import { redirect } from '@tanstack/react-router';

/**
 * Поэтапное открытие разделов панели.
 *
 * Панель доводится на реальных серверах поэтапно (план — `_dev/docs/master-plan.md`):
 * R1 открыл «Серверы» (позже раздел убран, его место заняли «Ноды») и подпункт «Провайдеры», R2 — «Обзор» и «Журнал», R3 — «События», R4 досрочно — «Ассистент», «База знаний» и вкладку «Настройки → Ассистент» (без неё ключ Ассистента нигде не ввести). Остальные разделы и вкладки настроек остаются закрытыми,
 * и недоступны по прямой ссылке: `requireSectionOpen` уводит на HOME_SECTION.
 * Чтобы открыть раздел на его этапе — добавь путь в OPEN_SECTIONS.
 */
export const HOME_SECTION = '/' as const;

export const OPEN_SECTIONS: ReadonlySet<string> = new Set<string>([
  HOME_SECTION,
  '/nodes',
  '/metrics',
  '/scenarios',
  '/integrations/dpi',
  '/integrations/dns',
  '/integrations/bschecker',
  '/billing/providers',
  // Биллинг: оплаты серверов, аренды, доменов и сертификатов.
  '/billing',
  '/audit',
  '/incidents',
  '/incidents/autofix',
  // R4 (досрочно, для чекпоинта): чат Ассистента, база знаний и настройка ключа Ассистента.
  '/assistant',
  '/knowledge',
  '/settings',
  '/settings/assistant',
  // R6: уведомления в Telegram; вместе с ними открыты остальные разделы настроек — все применяются сервером.
  '/settings/notifications',
  // Резервные копии панели: расписание, хранение, Telegram, восстановление.
  '/settings/backups',
  '/settings/appearance',
  '/settings/security',
  '/settings/monitoring',
  '/settings/incidents',
]);

export const LOCKED_HINT =
  'Раздел откроется на своём этапе. Сейчас открыты «Обзор», «События», «Журнал», «Ассистент», «База знаний» и «Настройки».';

export function isSectionOpen(to: string): boolean {
  return OPEN_SECTIONS.has(to);
}

/** Для beforeLoad закрытого маршрута: вместо раздела показываем HOME_SECTION. */
export function requireSectionOpen(to: string): void {
  if (!isSectionOpen(to)) throw redirect({ to: HOME_SECTION });
}
