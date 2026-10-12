-- Своих серверов больше нет: оплаты привязываются только к нодам Remnawave (node_refs). Колонка всегда пустая.
ALTER TABLE billing_items DROP COLUMN IF EXISTS server_ids;
