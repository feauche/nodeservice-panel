-- Профиль сервера в парке (J3): роль, важность, окно обслуживания, что должно работать; снимок фактического состояния.
ALTER TABLE "servers" ADD COLUMN "role" text;
ALTER TABLE "servers" ADD COLUMN "importance" text NOT NULL DEFAULT 'normal';
ALTER TABLE "servers" ADD COLUMN "maintenance_window" text;
ALTER TABLE "servers" ADD COLUMN "expected_containers" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "servers" ADD COLUMN "expected_ports" jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "servers" ADD COLUMN "inventory" jsonb;
ALTER TABLE "servers" ADD COLUMN "inventory_at" timestamp with time zone;
