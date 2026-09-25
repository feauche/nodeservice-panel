-- Уведомления знают, о каком сервере они: имя в тексте — токен {server}, подставляется при показе,
-- поэтому переименование сервера видно и в старых уведомлениях.
ALTER TABLE "notifications" ADD COLUMN "server_id" uuid;
ALTER TABLE "notifications" ADD COLUMN "server_name" text;

-- Уже созданные: сервер берём из ссылки, имя — из текста, и заменяем его токеном.
UPDATE "notifications"
SET "server_id" = substring("link_to" from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::uuid,
    "server_name" = regexp_replace("title", '^Обслуживание: ', ''),
    "title" = 'Обслуживание: {server}'
WHERE "link_to" ~ '^/servers\?open=[0-9a-f-]{36}$' AND "title" LIKE 'Обслуживание: %';

UPDATE "notifications" n
SET "server_id" = i."server_id",
    "server_name" = i."server_name",
    "title" = replace(n."title", i."server_name", '{server}'),
    "body" = replace(n."body", i."server_name", '{server}')
FROM "incidents" i
WHERE n."server_id" IS NULL
  AND n."link_to" ~ '^/incidents(\?open=|/)[0-9a-f-]{36}$'
  AND i."server_id" IS NOT NULL
  AND i."id" = substring(n."link_to" from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::uuid;
