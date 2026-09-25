-- Проверки доступности снаружи, сделанные ассистентом, хранятся в сообщении и показываются матрицей.
ALTER TABLE "assistant_messages" ADD COLUMN "reachability" jsonb NOT NULL DEFAULT '[]'::jsonb;
