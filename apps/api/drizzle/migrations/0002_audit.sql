-- Журнал (audit log): append-only, партиции по месяцам, полнотекстовый поиск.
-- Управляется вручную (не drizzle-kit): партиционированные таблицы и триггеры kit не описывает.
CREATE TABLE "audit_log" (
	"id" uuid NOT NULL DEFAULT uuidv7(),
	"seq" bigint GENERATED ALWAYS AS IDENTITY,
	"occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_display" text NOT NULL,
	"action" text NOT NULL,
	"category" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"target_display" text,
	"result" text NOT NULL,
	"severity" text NOT NULL,
	"source" text NOT NULL,
	"ip" inet,
	"user_agent" text,
	"request_id" text,
	"duration_ms" integer,
	"changes" jsonb,
	"metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
	"search" tsvector GENERATED ALWAYS AS (
		to_tsvector('simple',
			coalesce("action", '') || ' ' || coalesce("actor_display", '') || ' ' || coalesce("target_display", '') || ' ' ||
			coalesce("request_id", '') || ' ' || coalesce(host("ip"), '') || ' ' ||
			coalesce("metadata" ->> 'login', '') || ' ' || coalesce("metadata" ->> 'reason', ''))
	) STORED,
	CONSTRAINT "audit_log_pkey" PRIMARY KEY ("occurred_at", "id"),
	CONSTRAINT "audit_log_actor_type_check" CHECK ("actor_type" IN ('admin', 'system', 'anonymous')),
	CONSTRAINT "audit_log_category_check" CHECK ("category" IN ('auth', 'settings', 'security', 'system')),
	CONSTRAINT "audit_log_result_check" CHECK ("result" IN ('ok', 'failed', 'denied')),
	CONSTRAINT "audit_log_severity_check" CHECK ("severity" IN ('info', 'warn', 'crit')),
	CONSTRAINT "audit_log_source_check" CHECK ("source" IN ('manual', 'auto'))
) PARTITION BY RANGE ("occurred_at");
--> statement-breakpoint
CREATE INDEX "audit_log_occurred_idx" ON "audit_log" ("occurred_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE INDEX "audit_log_seq_idx" ON "audit_log" ("seq");
--> statement-breakpoint
CREATE INDEX "audit_log_category_idx" ON "audit_log" ("category", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" ("actor_id", "occurred_at" DESC);
--> statement-breakpoint
CREATE INDEX "audit_log_search_idx" ON "audit_log" USING gin ("search");
--> statement-breakpoint
-- Append-only: UPDATE/DELETE/TRUNCATE запрещены на уровне БД (триггер наследуется партициями).
-- Честная оговорка: суперпользователь БД может снять триггер — это защита от ошибок кода, не от админа.
CREATE FUNCTION audit_log_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'audit_log is append-only (% not allowed)', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_log_readonly_row" BEFORE UPDATE OR DELETE ON "audit_log"
	FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();
--> statement-breakpoint
CREATE TRIGGER "audit_log_readonly_truncate" BEFORE TRUNCATE ON "audit_log"
	FOR EACH STATEMENT EXECUTE FUNCTION audit_log_readonly();
--> statement-breakpoint
-- Создать раздел на месяц (idempotent). Возвращает имя, если раздел создан, иначе NULL.
CREATE FUNCTION audit_log_ensure_partition(month_start date) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
	first_day date := date_trunc('month', month_start)::date;
	part_name text := format('audit_log_y%sm%s', to_char(first_day, 'YYYY'), to_char(first_day, 'MM'));
BEGIN
	IF to_regclass(part_name) IS NOT NULL THEN
		RETURN NULL;
	END IF;
	EXECUTE format(
		'CREATE TABLE %I PARTITION OF audit_log FOR VALUES FROM (%L) TO (%L)',
		part_name, first_day, (first_day + interval '1 month')::date
	);
	RETURN part_name;
END;
$$;
--> statement-breakpoint
SELECT audit_log_ensure_partition(current_date);
--> statement-breakpoint
SELECT audit_log_ensure_partition((current_date + interval '1 month')::date);
