-- Связь сервера с нодой Remnawave: auto — панель находит её сама (по адресу и IP), none — ноды нет,
-- иначе — идентификатор ноды, выбранной вручную.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "node_link" text NOT NULL DEFAULT 'auto';
-- Внешние IP-адреса на сетевых интерфейсах сервера: по ним нода находит свой сервер, когда записана
-- по другому его адресу.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "addresses" jsonb NOT NULL DEFAULT '[]'::jsonb;
