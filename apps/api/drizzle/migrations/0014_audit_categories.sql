-- Новые категории Журнала: «База знаний» (knowledge) и «Ассистент» (assistant).
-- Без этого insert с такой категорией нарушает CHECK и не сохраняется.
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_category_check";
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_category_check" CHECK ("category" IN ('auth', 'settings', 'security', 'server', 'knowledge', 'assistant', 'system'));
