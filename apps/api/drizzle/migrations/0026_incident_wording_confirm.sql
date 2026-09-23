-- «ждёт «Да»» → «ждёт подтверждения»: старые записи хронологии и уведомлений переводим на новую формулировку.
UPDATE "incidents"
SET "timeline" = replace("timeline"::text, 'ждёт «Да»', 'ждёт подтверждения')::jsonb
WHERE "timeline"::text LIKE '%ждёт «Да»%';
UPDATE "notifications"
SET "title" = replace("title", 'ждёт «Да»', 'ждёт подтверждения'),
    "body" = replace(replace("body", 'ждёт «Да»', 'ждёт подтверждения'), 'Нажмите «Да»', 'Подтвердите запуск')
WHERE "title" LIKE '%ждёт «Да»%' OR "body" LIKE '%«Да»%';
