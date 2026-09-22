-- Дублирование серверов: несколько записей панели могут указывать на один host:port
ALTER TABLE "servers" DROP CONSTRAINT "servers_host_port_unique";
