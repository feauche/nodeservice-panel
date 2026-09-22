# Протокол агент ↔ панель, версия 1

Схемы — единственный источник правды: `packages/shared/src/agent-protocol.ts`.
Агент всегда сам ходит к панели (исходящие соединения, входящих портов у агента нет).

## Энроллмент (HTTP)

`POST /api/agent/v1/enroll` — без cookie и CSRF (не браузерный API).

Запрос: `{ token, pubkey, version, hostname? }` — одноразовый токен из карточки сервера
и публичный ключ ed25519 агента (base64, 32 байта). Панель пиннит ключ (TOFU): сменить его
можно только новым токеном. Ответ: `{ serverId, serverName, wsUrl }`.
Отказ — 400 без деталей (токен просрочен/отозван/использован — не раскрываем, что именно).

## WebSocket (`/api/agent/v1/ws`)

Конверт каждого сообщения: `{ v: 1, type, id: uuid, ts: ISO-8601 UTC, payload }`.

Последовательность:

| # | направление | type        | payload |
|---|-------------|-------------|---------|
| 1 | агент → панель | `hello`     | `{ serverId, pubkey, version }` |
| 2 | панель → агент | `challenge` | `{ nonce }` (base64, 32 случайных байта) |
| 3 | агент → панель | `auth`      | `{ signature }` — ed25519-подпись СЫРЫХ байт nonce |
| 4 | панель → агент | `welcome`   | `{ serverName, heartbeatSeconds, metricsSeconds }` |

После `welcome`: агент шлёт `heartbeat {}` каждые `heartbeatSeconds` (константа, 10 с)
и `metrics {…}` каждые `metricsSeconds` (из Настроек → Автопроверки; `0` — метрики выключены).
Поля метрик — `agentMetricsSchema` (cpu/load/mem/disk/net bps+pps/conntrack/uptime).

Ошибки: `error { code, message }`, коды `bad-envelope | auth-failed | unknown-server | protocol`.
`auth-failed` и `unknown-server` фатальны для агента (выход без реконнекта), остальное — backoff.

Статусы: успешный `auth` → сервер `online` (Журнал `server.agent.online`); разрыв соединения
или тишина heartbeat дольше порога из «Автопроверок» → `offline` (Журнал `server.agent.offline`).
Метрики пишутся в VictoriaMetrics (`VM_URL`, метрики `nodeservice_*` с лейблами server_id/server_name).

## Версионирование

`v` в конверте обязателен с первого сообщения. Несовместимые изменения — только с ростом `v`;
панель обязана отвечать `error bad-envelope` на неизвестную версию.
