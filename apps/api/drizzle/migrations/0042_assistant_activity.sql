-- Долгие действия Джарвиса при ответе (запуск проверки сервера): строки над ответом в чате.
ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "activity" jsonb DEFAULT '[]'::jsonb NOT NULL;
