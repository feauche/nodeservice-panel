-- Биллинг: что и когда оплачивать, история продлений с курсом ЦБ на день оплаты, курсы ЦБ по дням.
CREATE TABLE IF NOT EXISTS "billing_items" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('server', 'rent', 'domain', 'cert', 'other')),
  "title" text NOT NULL,
  "provider_id" uuid REFERENCES "providers"("id") ON DELETE SET NULL,
  "server_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "domain" text,
  "amount_minor" bigint NOT NULL CHECK ("amount_minor" >= 0),
  "currency" text NOT NULL CHECK ("currency" IN ('RUB', 'USD', 'EUR')),
  "period_unit" text NOT NULL CHECK ("period_unit" IN ('day', 'week', 'month', 'year', 'once')),
  "period_count" integer DEFAULT 1 NOT NULL CHECK ("period_count" >= 1),
  "paid_until" timestamp with time zone NOT NULL,
  "auto_charge" boolean DEFAULT false NOT NULL,
  "remind_days" integer,
  "note" text,
  "archived_at" timestamp with time zone,
  "notified_state" text,
  "notified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_items_due_idx" ON "billing_items" ("paid_until");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_payments" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
  "item_id" uuid NOT NULL REFERENCES "billing_items"("id") ON DELETE CASCADE,
  "paid_at" timestamp with time zone DEFAULT now() NOT NULL,
  "counted" boolean NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL,
  "rate" double precision NOT NULL,
  "amount_rub_minor" bigint NOT NULL,
  "extended_from" timestamp with time zone NOT NULL,
  "extended_to" timestamp with time zone NOT NULL,
  "actor_display" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_payments_item_idx" ON "billing_payments" ("item_id", "paid_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "billing_payments_paid_idx" ON "billing_payments" ("paid_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "billing_rates" (
  "date" text PRIMARY KEY NOT NULL,
  "usd" double precision NOT NULL,
  "eur" double precision NOT NULL,
  "fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
