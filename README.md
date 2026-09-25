# NodeService

Самохостируемая панель управления парком VPN/прокси-серверов: инвентарь серверов, безопасный
SSH-доступ и терминал прямо в браузере, живой мониторинг через лёгкого агента, инциденты и
авто-починка, Джарвис с базой знаний, уведомления.

## Установка на сервер

Чистый Ubuntu 24.04 / Debian 12, домен с A-записью на сервер, порты 80 и 443 свободны:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/feauche/nodeservice-panel/main/infra/scripts/install.sh)
```

Скрипт поставит Docker, соберёт и запустит панель (Caddy с авто-HTTPS, API, Postgres, Valkey,
VictoriaMetrics), настроит ежедневный бэкап и напечатает токен первого запуска. Обслуживание —
команда `nodeservice` (`update`, `rollback`, `backup`, `restore`, `logs`, `cli`). Подробно:
[`infra/README.md`](infra/README.md).

Агент для нод — отдельный репозиторий
[`nodeservice-agent`](https://github.com/feauche/nodeservice-agent): один статический Go-бинарь,
панель ставит его на сервер сама по SSH.

## Структура

```
apps/api          backend (NestJS + TypeScript): API, сессии, журнал, агенты, терминал, Джарвис
apps/web          frontend (React + Vite + TypeScript, Tailwind v4, shadcn/ui)
packages/shared   общие контракты (zod-схемы API, протокол панель↔агент)
infra/            Docker Compose (prod + dev), Caddy, скрипты установки и обслуживания
.github/          CI: lint, typecheck, tests, build
```

## Разработка

```bash
docker compose -f infra/compose.dev.yaml up -d      # Postgres 18, Valkey 8, VictoriaMetrics
cp apps/api/.env.example apps/api/.env
pnpm install
pnpm dev                                            # api :3000 (+ /api/backend-tools/docs), web :5173
```

Требуются Node 24 и pnpm 11. При первом старте API печатает токен первого запуска — открой
http://localhost:5173/setup. Потерял токен: `pnpm --filter api cli setup-token`; остальные команды
rescue CLI: `pnpm --filter api cli --help`.

Проверки: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; e2e бэкенда —
`pnpm --filter api test:e2e`. Фронт без бэкенда: `VITE_MOCK=1 pnpm --filter web dev`.

## Лицензия

Приватный проект. © LumaxDev.
