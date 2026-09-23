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
| `nodeservice backup [--to user@host:/dir]` | полный бэкап одним архивом `nodeservice-backup-<время>.tar.gz` (дамп БД + `.env` + meta) в `/opt/nodeservice/backups`, 14 дней; `--to` — копия по scp или в папку |
| `nodeservice restore <файл> [--yes]` | восстановить из архива на работающей панели: секреты из бэкапа переносятся в `.env`, БД заменяется (прежняя сохраняется как `nodeservice_pre_restore_*`), api перезапускается |
| `nodeservice cli setup-token` | rescue CLI: `setup-token`, `list-users`, `reset-password`, `disable-2fa`, `revoke-sessions` |
| `nodeservice uninstall` | снять панель: бэкап БД и `.env` в `/root/nodeservice-last-backup`, затем контейнеры, образы, тома, `/opt/nodeservice`, cron и сама команда. Docker и deploy-ключ остаются |

`infra/.env` — единственное место с секретами. Без `ENCRYPTION_KEY` из него зашифрованные данные
(TOTP, доступы к серверам, SSH-ключ панели) не восстановить, поэтому он лежит внутри архива бэкапа.

## Переезд на другой сервер / восстановление с нуля

1. На старом сервере: `nodeservice backup` (или `nodeservice backup --to root@новый:/root`), скачать
   архив `nodeservice-backup-<время>.tar.gz`.
2. На чистом сервере одной командой:
   ```bash
   bash <(curl -fsSL https://raw.githubusercontent.com/feauche/nodeservice-panel/main/infra/scripts/install.sh) --restore /root/nodeservice-backup-<время>.tar.gz
   ```
   Установщик возьмёт секреты и данные из архива, домен предложит прежний (при том же домене
   агенты на нодах переподключатся сами, ничего переустанавливать не нужно).
3. Переключить A-запись домена на новый сервер. Сертификат Caddy выпустит сам.

В бэкап не входит история метрик (графики заполнятся заново) и сессии входа.

## Что растёт и как чистится

| Данные | Где | Срок | Как |
|---|---|---|---|
| Журнал | Postgres, `audit_log` по месяцам | `AUDIT_RETENTION_MONTHS` (12) | старые разделы удаляются целиком ночью |
| Записи веб-терминала | Postgres, до 2 МБ на сессию | `TERMINAL_RETENTION_DAYS` (90) | ночная чистка в 03:47 |
| Запуски обслуживания с логами | Postgres, до 200 КБ на запуск | `MAINTENANCE_RETENTION_DAYS` (90) | ночная чистка |
| Решённые инциденты | Postgres | `INCIDENTS_RETENTION_DAYS` (365) | ночная чистка, открытые не трогаются |
| Метрики | VictoriaMetrics | 90 дней | `--retentionPeriod=90d` в compose |
| Логи контейнеров | Docker json-file | 5 × 10 МБ на контейнер | ротация Docker |

Строки в Postgres лежат на диске, а не в памяти: сотни тысяч записей Журнала — это десятки мегабайт
на диске и постраничная выдача в панели, оперативную память они не занимают.

## Разработка

`compose.dev.yaml` — только Postgres/Valkey/VictoriaMetrics с открытыми портами для `pnpm dev`.
