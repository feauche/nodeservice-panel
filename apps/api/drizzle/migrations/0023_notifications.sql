-- Центр уведомлений: колокольчик в шапке. Всё, что панель показывает всплывашками, плюс фоновые события.
CREATE TABLE "notifications" (
  "id" uuid PRIMARY KEY DEFAULT uuidv7(),
  "severity" text NOT NULL DEFAULT 'info',
  "title" text NOT NULL,
  "body" text,
  "link_to" text,
  "link_label" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "read_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" ("created_at");
