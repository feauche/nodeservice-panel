-- 0.90.0: советы проверок под ответом Ассистента и метка «откуда задан вопрос» (событие или нода).
ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "advice" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "assistant_messages" ADD COLUMN IF NOT EXISTS "context" jsonb;
