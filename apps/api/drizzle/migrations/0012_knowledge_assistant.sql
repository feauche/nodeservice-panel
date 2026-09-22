-- Этап 9: база знаний (FTS) и беседы ассистента
CREATE TABLE "kb_documents" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "title" text NOT NULL,
  "content" text NOT NULL DEFAULT '',
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "archived" boolean NOT NULL DEFAULT false,
  "search" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce("content", '')), 'B')
  ) STORED,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "kb_search_idx" ON "kb_documents" USING gin ("search");
CREATE INDEX "kb_updated_idx" ON "kb_documents" ("updated_at" DESC);

CREATE TABLE "assistant_conversations" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "title" text NOT NULL DEFAULT 'Новый чат',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE TABLE "assistant_messages" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" uuid NOT NULL REFERENCES "assistant_conversations"("id") ON DELETE CASCADE,
  "role" text NOT NULL,
  "content" text NOT NULL,
  "citations" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "proposals" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX "assistant_msg_conv_idx" ON "assistant_messages" ("conversation_id", "created_at");
