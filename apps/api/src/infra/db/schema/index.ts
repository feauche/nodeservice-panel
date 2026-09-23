/**
 * Схема БД (Drizzle). Таблицы добавляются по этапам:
 *  - этап 1: users, recovery_codes, trusted_devices, setup_tokens
 *  - этап 2: audit_log (партиционирована помесячно raw-SQL миграцией)
 *  - этап 4: servers, enrollment_tokens …
 */
export * from './auth.js';
export * from './incidents.js';
export * from './knowledge.js';
export * from './meta.js';
export * from './notifications.js';
export * from './servers.js';
