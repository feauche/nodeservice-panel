ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_listen_port" integer;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_access_key_enc" text;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_tls_cert" text;

ALTER TABLE "servers" DROP CONSTRAINT IF EXISTS "servers_agent_listen_port_range";
ALTER TABLE "servers" ADD CONSTRAINT "servers_agent_listen_port_range"
  CHECK ("agent_listen_port" IS NULL OR "agent_listen_port" BETWEEN 10000 AND 65535);

CREATE UNIQUE INDEX IF NOT EXISTS "servers_agent_listen_port_unique"
  ON "servers" ("agent_listen_port")
  WHERE "agent_listen_port" IS NOT NULL;
