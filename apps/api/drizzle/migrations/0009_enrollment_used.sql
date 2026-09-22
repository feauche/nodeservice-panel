-- Токен подключения агента одноразовый: фиксируем момент использования
ALTER TABLE "enrollment_tokens" ADD COLUMN "used_at" timestamp with time zone;
