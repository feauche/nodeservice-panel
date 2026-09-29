-- Канал сервера для расчёта ёмкости: что показала сетевая карта, замер скорости, значение вручную.
CREATE TABLE IF NOT EXISTS "server_link" (
  "server_id" uuid PRIMARY KEY REFERENCES "servers"("id") ON DELETE CASCADE,
  "nic_name" text,
  "nic_mbit" integer,
  "nic_virtual" boolean,
  "conntrack_max" integer,
  "probed_at" timestamptz,
  "measured_down_mbit" integer,
  "measured_up_mbit" integer,
  "measured_at" timestamptz,
  "manual_mbit" integer
);
