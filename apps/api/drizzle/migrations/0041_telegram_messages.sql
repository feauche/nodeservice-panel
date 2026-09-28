-- Сообщения Telegram по инцидентам: «Починилось» уходит ответом на исходное сообщение.
CREATE TABLE IF NOT EXISTS "telegram_messages" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "incident_id" uuid NOT NULL REFERENCES "incidents"("id") ON DELETE CASCADE,
  "destination_id" text NOT NULL,
  "message_id" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "telegram_messages_incident_idx" ON "telegram_messages" ("incident_id", "destination_id");
