-- Изменения по предложению Джарвиса (J5): предложение, превью, решение человека и итог.
CREATE TABLE "assistant_changes" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "conversation_id" uuid REFERENCES "assistant_conversations"("id") ON DELETE SET NULL,
  "operation" text NOT NULL,
  "args" jsonb NOT NULL,
  "reason" text,
  "plan" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'proposed',
  "note" text,
  "decided_by" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);
CREATE INDEX "assistant_changes_created_idx" ON "assistant_changes" ("created_at");
CREATE INDEX "assistant_changes_conv_idx" ON "assistant_changes" ("conversation_id");
