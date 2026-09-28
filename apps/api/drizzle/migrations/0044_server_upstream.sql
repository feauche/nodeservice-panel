-- Откуда приходит трафик на сервер-выход: свой мост или вход арендодателя.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "upstream" jsonb;
