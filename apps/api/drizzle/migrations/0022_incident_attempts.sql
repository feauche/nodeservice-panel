-- Инциденты R3: попытки починки (пред-проверка → действие → пост-проверка → откат) и предложенный шаг.
ALTER TABLE "incidents" ADD COLUMN "attempts" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "proposal" jsonb;
