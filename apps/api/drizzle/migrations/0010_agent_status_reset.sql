-- «Ожидает агента» без единой регистрации агента — ложное состояние старых версий
-- (статус ставился при выпуске токена). Возвращаем таким серверам «Агент не установлен».
UPDATE "servers" SET "agent_status" = 'not_installed'
WHERE "agent_status" = 'pending' AND "agent_enrolled_at" IS NULL;
