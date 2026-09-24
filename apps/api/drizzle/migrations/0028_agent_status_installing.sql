-- Статус «Агент устанавливается…» на время установки по SSH (живой поток показывает его в карточке).
ALTER TABLE "servers" DROP CONSTRAINT "servers_agent_status_check";
ALTER TABLE "servers" ADD CONSTRAINT "servers_agent_status_check"
  CHECK ("agent_status" IN ('not_installed', 'installing', 'pending', 'online', 'offline'));
