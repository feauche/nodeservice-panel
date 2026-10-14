/**
 * @nodeservice/shared — общие контракты панели.
 * Этап 1: auth API, настройки. Этап 2: Журнал (аудит).
 */
/** Версия панели x.y.z. Поднимается каждой поставкой: `node scripts/bump-version.mjs patch` (фиксы) или `minor` (новые возможности). */
export const SHARED_VERSION = '0.103.1';
export * from './assistant.js';
export * from './audit.js';
export * from './auth.js';
export * from './backups.js';
export * from './billing.js';
export * from './bs-rentals.js';
export * from './bschecker.js';
export * from './changelog.js';
export * from './countries.js';
export * from './incidents.js';
export * from './integration-workspaces.js';
export * from './integrations.js';
export * from './knowledge.js';
export * from './monitoring.js';
export * from './node-capacity.js';
export * from './node-metrics.js';
export * from './node-stats.js';
export * from './notifications.js';
export * from './panel-release.js';
export * from './providers.js';
export * from './remnawave.js';
export * from './scenario-journal.js';
export * from './scenarios.js';
export * from './security.js';
export * from './settings.js';
export * from './tcp-check.js';
export * from './telegram.js';
// Русские тексты ошибок проверки полей — подключаются при загрузке пакета (z.config).
export * from './zod-ru.js';
