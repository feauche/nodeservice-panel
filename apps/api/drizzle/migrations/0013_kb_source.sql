-- База знаний: источник статьи (откуда взята информация) для бейджа.
-- self — вручную, ai — собрано ассистентом, web — из веба, telegram — из Telegram.
ALTER TABLE "kb_documents" ADD COLUMN "source" text DEFAULT 'self' NOT NULL;
