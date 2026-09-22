/**
 * @nodeservice/shared — общие контракты панели.
 * Этап 1: auth API, настройки. Этап 2: Журнал (аудит). Этап 5 добавит протокол агента (v1).
 */
/** Версия панели: 0.<последний завершённый этап>.<фиксы>. Поднимается при закрытии этапа. */
export const SHARED_VERSION = '0.9.1';
export * from './agent-protocol.js';
export * from './assistant.js';
export * from './audit.js';
export * from './auth.js';
export * from './autochecks.js';
export * from './incidents.js';
export * from './knowledge.js';
export * from './metrics.js';
export * from './security.js';
export * from './servers.js';
export * from './settings.js';
export * from './terminal.js';
