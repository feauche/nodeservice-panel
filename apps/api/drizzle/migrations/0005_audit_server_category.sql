-- Этап 4 добавил категорию server в Журнал. Урок: CHECK в БД и enum в shared должны меняться вместе.
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_category_check";
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_category_check" CHECK ("category" IN ('auth', 'settings', 'security', 'server', 'system'));
