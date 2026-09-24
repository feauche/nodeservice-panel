-- Нода на сервере: следить ли за контейнером (auto/on/off) и что зонд видел в последний раз.
ALTER TABLE "servers" ADD COLUMN "node_watch" text NOT NULL DEFAULT 'auto';
ALTER TABLE "servers" ADD COLUMN "node_state" text;
