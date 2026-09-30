-- Сообщения Telegram, которые ждут разбора Джарвиса: признак «ждёт отправки» переживает перезапуск панели.
-- alert — что отправить, queued — события того же дела, вставшие в очередь за ним.
CREATE TABLE IF NOT EXISTS "telegram_pending" (
  "incident_id" uuid PRIMARY KEY REFERENCES "incidents"("id") ON DELETE CASCADE,
  "alert" jsonb NOT NULL,
  "queued" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
