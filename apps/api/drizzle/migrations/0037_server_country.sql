-- Страна сервера: выбрана вручную или определена по IP несколькими геосервисами (автоматика ручной выбор не трогает).
ALTER TABLE "servers" ADD COLUMN "country" text;
ALTER TABLE "servers" ADD COLUMN "country_source" text NOT NULL DEFAULT 'auto';
ALTER TABLE "servers" ADD COLUMN "country_status" text NOT NULL DEFAULT 'none';
ALTER TABLE "servers" ADD COLUMN "country_agree" integer;
ALTER TABLE "servers" ADD COLUMN "country_total" integer;
ALTER TABLE "servers" ADD COLUMN "country_checked_at" timestamp with time zone;
ALTER TABLE "servers" ADD COLUMN "country_note" text;
ALTER TABLE "servers" ADD COLUMN "country_candidate" text;
ALTER TABLE "servers" ADD COLUMN "country_candidate_count" integer NOT NULL DEFAULT 0;
