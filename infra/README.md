# infra — установка и обслуживание панели

Стек в `compose.yaml`: Caddy (авто-HTTPS, HTTP/3) → api (NestJS + собранный фронт в `public/`),
Postgres 18, Valkey 8, VictoriaMetrics. Наружу открыты только 80/443 у Caddy.

## Установка одной командой (чистый Ubuntu 24.04 / Debian 12, root)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/feauche/nodeservice-panel/main/infra/scripts/install.sh)
```

Скрипт спросит домен и e-mail для Let's Encrypt, поставит Docker, склонирует репозиторий в
`/opt/nodeservice` (репозиторий приватный: покажет deploy-ключ, который надо добавить в
Settings → Deploy keys), сгенерирует `infra/.env` с секретами, соберёт образ api из исходников,
поднимет стек, поставит команду `nodeservice` и ежедневный бэкап БД, напечатает токен первого
запуска. Повторный запуск безопасен: `.env` и данные не трогаются.

Требования: домен с A-записью на сервер, 2 vCPU / 4 ГБ (при меньшей памяти скрипт добавит swap
для сборки), порты 80/443 свободны.

## Обслуживание — команда `nodeservice`

| Команда | Что делает |
|---|---|
| `nodeservice status` | контейнеры, версия кода |
| `nodeservice logs [api]` | логи |
| `nodeservice update [ref]` | бэкап → git fetch (по умолчанию `origin/main`) → сборка → перезапуск; миграции применяет api при старте |
| `nodeservice rollback` | вернуть предыдущий образ api |
| `nodeservice backup` / `restore <файл>` | pg_dump в `/opt/nodeservice/backups` (14 дней) + копия `.env`; восстановление с остановкой api |
| `nodeservice cli setup-token` | rescue CLI: `setup-token`, `list-users`, `reset-password`, `disable-2fa`, `revoke-sessions` |
| `nodeservice uninstall` | снять панель: бэкап БД и `.env` в `/root/nodeservice-last-backup`, затем контейнеры, образы, тома, `/opt/nodeservice`, cron и сама команда. Docker и deploy-ключ остаются |

`infra/.env` — единственное место с секретами. Без `ENCRYPTION_KEY` из него зашифрованные данные
(TOTP, доступы к серверам) не восстановить, поэтому бэкап кладёт его копию рядом с дампом.

## Разработка

`compose.dev.yaml` — только Postgres/Valkey/VictoriaMetrics с открытыми портами для `pnpm dev`.
