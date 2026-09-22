-- Коды восстановления можно посмотреть повторно (как в GitHub/Google): рядом с argon2-хешем
-- храним копию, зашифрованную ENCRYPTION_KEY (тем же ключом, что и секрет 2FA). Просмотр — за step-up и в Журнал.
ALTER TABLE "recovery_codes" ADD COLUMN "code_enc" text;
--> statement-breakpoint
ALTER TABLE "recovery_codes" ADD COLUMN "position" integer NOT NULL DEFAULT 0;
