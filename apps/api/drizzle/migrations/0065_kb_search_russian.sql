-- 0.101.0: поиск по базе знаний находит другие формы русских слов («блокировка» → «Блокировки») и теги.
-- Индекс хранит слова как есть (simple: точные термины, команды, адреса) и их основы (russian: морфология);
-- теги — с весом заголовка. Выражение меняется на месте (PostgreSQL 17+), индекс перестраивается сам.
ALTER TABLE "kb_documents" ALTER COLUMN "search" SET EXPRESSION AS (
  setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('russian', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("tags"::text, '')), 'A') ||
  setweight(to_tsvector('russian', coalesce("tags"::text, '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("content", '')), 'B') ||
  setweight(to_tsvector('russian', coalesce("content", '')), 'B')
);
