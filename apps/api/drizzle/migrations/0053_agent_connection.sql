-- Фактический маршрут и транспорт последнего сигнала агента для честного статуса в карточке сервера.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_transport" text;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_route" text;
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "agent_route_fallback" boolean;

ALTER TABLE "servers" DROP CONSTRAINT IF EXISTS "servers_agent_transport_check";
ALTER TABLE "servers" ADD CONSTRAINT "servers_agent_transport_check"
  CHECK ("agent_transport" IS NULL OR "agent_transport" IN ('websocket', 'https'));
