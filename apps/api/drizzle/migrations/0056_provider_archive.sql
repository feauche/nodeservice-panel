ALTER TABLE "providers" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "providers_active_name_idx"
  ON "providers" (lower("name"))
  WHERE "archived_at" IS NULL;
