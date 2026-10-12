-- 0.89.0: панель работает только через Remnawave. Свои серверы, терминал, SSH, агент, обслуживание, проверки
-- серверов, предложения Ассистента и журнал колокольчика удалены — их таблицы и секреты больше не нужны.

-- События видов, которые панель больше не отслеживает, иначе висели бы открытыми вечно и раздували счётчик.
UPDATE incidents
SET status = 'resolved',
    resolved_at = now(),
    resolved_by = 'auto',
    proposal = NULL,
    timeline = timeline || jsonb_build_array(jsonb_build_object(
      'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'by', 'auto',
      'action', 'Закрыто при обновлении: этот вид событий панель больше не отслеживает',
      'result', 'resolved'))
WHERE status <> 'resolved' AND kind IN ('agent_offline', 'ssh_down', 'disk_high');
--> statement-breakpoint
ALTER TABLE incidents DROP CONSTRAINT IF EXISTS incidents_server_id_fkey;
--> statement-breakpoint
UPDATE incidents SET server_id = NULL WHERE server_id IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS incidents_open_uq;
--> statement-breakpoint
-- Оплаты остаются; из карточек просто пропадают старые серверы, привязки к нодам не трогаются.
UPDATE billing_items SET server_ids = '[]'::jsonb WHERE server_ids <> '[]'::jsonb;
--> statement-breakpoint
DROP TABLE IF EXISTS terminal_sessions, maintenance_runs, maintenance_state, server_checks, server_link, enrollment_tokens, assistant_changes, notifications, servers;
--> statement-breakpoint
-- Секреты и настройки удалённых возможностей: ключ SSH панели, сниппеты терминала, отметка обслуживания.
DELETE FROM app_meta WHERE key IN ('panel.ssh-key', 'settings.snippets', 'maintenance.daily-sweep.completed-at');
--> statement-breakpoint
-- Ссылка сервисной подписки для «настоящей проверки VPN» (её выполняли агенты) — рабочий VPN-доступ, стираем.
UPDATE app_meta
SET value = ((value::jsonb) - 'vpnProbeUrlEnc' - 'vpnProbeRoutes' - 'vpnProbeRouteDetails')::text, updated_at = now()
WHERE key = 'settings.remnawave' AND value LIKE '{%';
--> statement-breakpoint
-- Разрешения Ассистента: экрана для них нет, запись в базу знаний включена всегда.
UPDATE app_meta
SET value = ((value::jsonb) - 'permissions')::text, updated_at = now()
WHERE key = 'settings.assistant' AND value LIKE '{%';
