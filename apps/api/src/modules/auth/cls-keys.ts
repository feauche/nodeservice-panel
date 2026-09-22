/**
 * Ключи CLS, которые ставит SessionGuard и читает Журнал.
 * Отдельный файл — чтобы session.guard ↔ audit.service не импортировали друг друга по кругу.
 */
export const CLS_USER = 'auth.user';
export const CLS_SESSION = 'auth.session';
