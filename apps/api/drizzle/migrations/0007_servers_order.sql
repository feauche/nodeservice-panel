-- Ручной порядок карточек серверов (drag-and-drop)
ALTER TABLE "servers" ADD COLUMN "sort_order" integer NOT NULL DEFAULT 0;
UPDATE "servers" s SET "sort_order" = t.rn FROM (
  SELECT id, row_number() OVER (ORDER BY name) - 1 AS rn FROM "servers"
) t WHERE s.id = t.id;
