ALTER TABLE "billing_items" ADD COLUMN IF NOT EXISTS "billing_day" integer;
ALTER TABLE "billing_items" ADD COLUMN IF NOT EXISTS "billing_time_zone" text NOT NULL DEFAULT 'Europe/Moscow';

-- Для существующих карточек восстанавливаем исходное число из истории продлений.
UPDATE "billing_items" i
SET "billing_day" = greatest(
  extract(day FROM i."paid_until" AT TIME ZONE i."billing_time_zone")::integer,
  coalesce((
    SELECT max(extract(day FROM p."extended_from" AT TIME ZONE i."billing_time_zone")::integer)
    FROM "billing_payments" p
    WHERE p."item_id" = i."id"
  ), 1)
)
WHERE i."billing_day" IS NULL;

ALTER TABLE "billing_items" ALTER COLUMN "billing_day" SET DEFAULT 1;
ALTER TABLE "billing_items" ALTER COLUMN "billing_day" SET NOT NULL;
ALTER TABLE "billing_items" ADD CONSTRAINT "billing_items_billing_day_check" CHECK ("billing_day" BETWEEN 1 AND 31);
