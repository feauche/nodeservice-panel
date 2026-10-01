-- Неудавшиеся доставки Telegram: отдельная запись на чат переживает перезапуск панели.
CREATE TABLE IF NOT EXISTS "telegram_outbox" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "destination_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "telegram_outbox_due_idx"
  ON "telegram_outbox" USING btree ("next_attempt_at", "created_at");
CREATE INDEX IF NOT EXISTS "telegram_outbox_destination_idx"
  ON "telegram_outbox" USING btree ("destination_id", "created_at", "id");
