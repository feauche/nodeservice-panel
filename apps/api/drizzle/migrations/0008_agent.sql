-- Этап 5: привязка агента к серверу (TOFU-пиннинг ключа) и его состояние
ALTER TABLE "servers" ADD COLUMN "agent_pubkey" text;
ALTER TABLE "servers" ADD COLUMN "agent_version" text;
ALTER TABLE "servers" ADD COLUMN "agent_enrolled_at" timestamp with time zone;
ALTER TABLE "servers" ADD COLUMN "agent_last_seen_at" timestamp with time zone;
