-- Сигналы в момент открытия инцидента: метрики агента и состояние контейнера ноды.
ALTER TABLE "incidents" ADD COLUMN "snapshot" jsonb;
