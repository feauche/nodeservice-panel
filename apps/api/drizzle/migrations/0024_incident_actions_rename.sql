-- «Перезапустить Xray» убран из реестра: старые попытки и предложения переименовываем в
-- «Перезапустить контейнер ноды», чтобы страница инцидентов их показывала.
UPDATE "incidents"
SET "attempts" = replace("attempts"::text, '"action":"restart_xray"', '"action":"restart_node"')::jsonb
WHERE "attempts"::text LIKE '%"action":"restart_xray"%';
--> statement-breakpoint
UPDATE "incidents"
SET "proposal" = replace("proposal"::text, '"action":"restart_xray"', '"action":"restart_node"')::jsonb
WHERE "proposal"::text LIKE '%"action":"restart_xray"%';
