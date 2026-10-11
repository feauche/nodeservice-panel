-- Separate local billing identity from the remote provider UUID; preserve existing FK/history.
ALTER TABLE "providers" ADD COLUMN "remote_panel" text;
ALTER TABLE "providers" ADD COLUMN "remote_uuid" uuid;
ALTER TABLE "providers" DROP CONSTRAINT IF EXISTS "providers_name_key";
ALTER TABLE "providers" DROP CONSTRAINT IF EXISTS "providers_name_unique";
CREATE UNIQUE INDEX "providers_legacy_name_unique" ON "providers" ("name") WHERE "remote_panel" IS NULL;
CREATE UNIQUE INDEX "providers_remote_identity_unique" ON "providers" ("remote_panel", "remote_uuid");
