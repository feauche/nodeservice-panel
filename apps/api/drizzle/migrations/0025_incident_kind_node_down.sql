-- «Xray не запущен» (xray_down) заменён на «Контейнер ноды не запущен» (node_down): переводим старые записи.
UPDATE "incidents"
SET "kind" = 'node_down',
    "title" = replace("title", 'Xray не запущен', 'Контейнер ноды не запущен')
WHERE "kind" = 'xray_down';
