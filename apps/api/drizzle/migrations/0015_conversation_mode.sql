-- Режим закреплён за беседой: в существующем чате нельзя сменить агента на анализ.
ALTER TABLE "assistant_conversations" ADD COLUMN "mode" text DEFAULT 'agent' NOT NULL;
