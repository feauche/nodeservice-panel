-- Провайдеры (хостеры): справочник с иконкой сайта; у сервера — необязательная ссылка на провайдера.
CREATE TABLE "providers" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "name" text NOT NULL UNIQUE,
  "site_url" text NOT NULL,
  "note" text,
  "icon_type" text,
  "icon_data" text,
  "icon_version" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "provider_id" uuid REFERENCES "providers"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX "servers_provider_idx" ON "servers" ("provider_id");
