-- История веб-терминала: запись вывода каждой PTY-сессии (ввод не пишется).
CREATE TABLE "terminal_sessions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "actor_id" uuid,
  "actor_display" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "ended_at" timestamptz,
  "cols" integer NOT NULL DEFAULT 80,
  "rows" integer NOT NULL DEFAULT 24,
  "transcript" text NOT NULL DEFAULT '',
  "bytes_out" bigint NOT NULL DEFAULT 0,
  "truncated" boolean NOT NULL DEFAULT false,
  "exit_code" integer,
  "end_reason" text
);
--> statement-breakpoint
CREATE INDEX "terminal_sessions_server_idx" ON "terminal_sessions" ("server_id", "started_at" DESC);
