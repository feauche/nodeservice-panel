-- Этап 8: инциденты с таймлайном
CREATE TABLE "incidents" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "server_id" uuid REFERENCES "servers"("id") ON DELETE SET NULL,
  "server_name" text NOT NULL,
  "kind" text NOT NULL,
  "severity" text NOT NULL,
  "status" text NOT NULL DEFAULT 'open',
  "title" text NOT NULL,
  "detail" text NOT NULL DEFAULT '',
  "timeline" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "last_autofix_at" timestamp with time zone,
  "opened_at" timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at" timestamp with time zone,
  "resolved_by" text
);
-- Один открытый инцидент на (сервер, вид): частичный уникальный индекс.
CREATE UNIQUE INDEX "incidents_open_uq" ON "incidents" ("server_id", "kind") WHERE "status" <> 'resolved';
CREATE INDEX "incidents_opened_idx" ON "incidents" ("opened_at" DESC);
