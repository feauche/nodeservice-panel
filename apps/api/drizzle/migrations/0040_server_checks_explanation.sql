-- Пересказ результата проверки Джарвисом по кнопке «Объяснить».
ALTER TABLE "server_checks" ADD COLUMN IF NOT EXISTS "explanation" text;
