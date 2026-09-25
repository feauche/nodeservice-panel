-- Закреплённая служебная статья: глоссарий «Пояснения» всегда сверху и не удаляется.
ALTER TABLE "kb_documents" ADD COLUMN "pinned" boolean NOT NULL DEFAULT false;
UPDATE "kb_documents" SET "pinned" = true WHERE "title" = 'Пояснения';
