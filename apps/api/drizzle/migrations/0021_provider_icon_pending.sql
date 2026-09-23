-- Иконка провайдера ищется в фоне после сохранения: пока ищем — icon_pending = true.
ALTER TABLE "providers" ADD COLUMN "icon_pending" boolean NOT NULL DEFAULT false;
