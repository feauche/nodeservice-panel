-- История версий статьи: снимок предыдущего состояния при каждом изменении — для отката.
CREATE TABLE "kb_document_versions" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "doc_id" uuid NOT NULL REFERENCES "kb_documents"("id") ON DELETE CASCADE,
  "title" text NOT NULL,
  "content" text NOT NULL,
  "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "source" text NOT NULL,
  "archived" boolean NOT NULL DEFAULT false,
  "reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "kb_versions_doc_idx" ON "kb_document_versions" ("doc_id", "created_at" DESC);
