CREATE TABLE IF NOT EXISTS "remnawave_config_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "hash" text NOT NULL,
  "snapshot" jsonb NOT NULL,
  "changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "captured_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "remnawave_config_snapshots_captured_idx"
  ON "remnawave_config_snapshots" ("captured_at");
