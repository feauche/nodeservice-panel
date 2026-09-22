-- Обслуживание сервера (R1.8): суточная проверка (чек-лист) и запуски действий с пошаговым логом.
CREATE TABLE "maintenance_state" (
  "server_id" uuid PRIMARY KEY REFERENCES "servers"("id") ON DELETE CASCADE,
  "checked_at" timestamptz,
  "check" jsonb,
  "check_error" text,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "maintenance_runs" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "server_id" uuid NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "actor_id" uuid,
  "actor_display" text,
  "steps" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "log" text NOT NULL DEFAULT '',
  "error" text,
  CONSTRAINT "maintenance_runs_status_check" CHECK ("status" IN ('running', 'ok', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "maintenance_runs_server_idx" ON "maintenance_runs" ("server_id", "started_at" DESC);
--> statement-breakpoint
-- Один идущий запуск на сервер: страховка от гонки двух запросов и второго процесса панели.
CREATE UNIQUE INDEX "maintenance_runs_one_running" ON "maintenance_runs" ("server_id") WHERE "status" = 'running';
