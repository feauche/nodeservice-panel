/**
 * @nodeservice/shared — общие контракты панели.
 * Этап 1: auth API, настройки. Этап 2: Журнал (аудит). Этап 5 добавит протокол агента (v1).
 */
/** Версия панели x.y.z. Поднимается каждой поставкой: `node scripts/bump-version.mjs patch` (фиксы) или `minor` (новые возможности). */
export const SHARED_VERSION = '0.10.0';
export * from './agent-protocol.js';
export * from './assistant.js';
export * from './audit.js';
export * from './auth.js';
export * from './autochecks.js';
export * from './incidents.js';
export * from './knowledge.js';
export * from './maintenance.js';
export * from './metrics.js';
export * from './notifications.js';
export * from './providers.js';
export * from './security.js';
export * from './servers.js';
export * from './settings.js';
export * from './terminal.js';
