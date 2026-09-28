-- Реестр проверок сервера (R5/J9): запуски с сырым выводом скрипта.
CREATE TABLE IF NOT EXISTS "server_checks" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "check" text NOT NULL,
  "status" text DEFAULT 'running' NOT NULL,
  "trigger" text NOT NULL,
  "actor_display" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "output" text DEFAULT '' NOT NULL,
  "error" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "server_checks_server_idx" ON "server_checks" ("server_id", "check", "started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "server_checks_one_running" ON "server_checks" ("server_id") WHERE "status" = 'running';
