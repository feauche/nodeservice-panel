-- Функции сервера: из одной роли в набор (в простой схеме один сервер и вход, и выход); «relay» стал «bridge» (мост).
ALTER TABLE "servers" ADD COLUMN "roles" jsonb NOT NULL DEFAULT '[]'::jsonb;
UPDATE "servers" SET "roles" = jsonb_build_array(CASE "role" WHEN 'relay' THEN 'bridge' ELSE "role" END) WHERE "role" IS NOT NULL;
ALTER TABLE "servers" DROP COLUMN "role";
