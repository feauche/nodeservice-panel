# NodeService

Самохостируемая панель мониторинга нод Remnawave: состояние парка, онлайн, трафик и метрики,
папки и порядок нод, инциденты, биллинг, интеграции DPI Checker и DNS (REG.RU и Cloudflare),
база знаний, журнал и Telegram-доставка. Ассистент отвечает на вопросы по доступным данным
панели и базе знаний; самостоятельно команды и изменения не выполняет.

Ноды подключаются через Remnawave API. Для этой работы устанавливать агент NodeService
на ноды и предоставлять панели SSH-доступ не требуется.

## Установка на сервер

Чистый Ubuntu 24.04 / Debian 12, домен с A-записью на сервер, порты 80 и 443 свободны.
Команду выполнить под `root`:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/feauche/nodeservice-panel/main/infra/scripts/install.sh)
```

Скрипт поставит Docker, соберёт и запустит панель (Caddy с авто-HTTPS, API, Postgres, Valkey,
VictoriaMetrics), напечатает токен первого запуска. Caddy принимает запросы на домене и
автоматически выпускает HTTPS-сертификат. Расписание копий настраивается в панели:
«Настройки → Резервные копии». Обслуживание —
команда `nodeservice` (`update`, `rollback`, `backup`, `restore`, `logs`, `cli`). Подробно:
[`infra/README.md`](infra/README.md).

По умолчанию установщик выбирает последний опубликованный стабильный GitHub Release.
Обычное обновление установленной панели: `nodeservice update`.

## Подключение Remnawave

После первоначальной настройки открой раздел «Ноды» и укажи адрес панели Remnawave и её
API-ключ. NodeService получает ноды и доступные метрики через API; папки и порядок нод
сохраняются в NodeService. Подключения BS Checker, DPI Checker, REG.RU и Cloudflare настраиваются отдельно
в разделе «Интеграции».

## Структура

```
apps/api          backend (NestJS + TypeScript): API, Remnawave, интеграции, мониторинг, Ассистент
apps/web          frontend (React + Vite + TypeScript, Tailwind v4, shadcn/ui)
packages/shared   общие контракты и zod-схемы API
infra/            Docker Compose (prod + dev), Caddy, скрипты установки и обслуживания
.github/          CI: lint, typecheck, tests, build
```

Сервер остаётся одним приложением с отдельными модулями:

- `remnawave` — подключение и актуальное состояние нод.
- `node-metrics` — расписание опроса, сохранение метрик и чтение истории.
- `incidents` — обнаружение сбоев и их жизненный цикл; индивидуальные CPU/RAM-пороги
  наследуют общие настройки, если поля ноды пустые.
- `integrations/bschecker`, `integrations/dpi`, `integrations/dns` — собственные сервисы,
  кэш и операции каждой интеграции. `integration-connections` хранит подключения;
  `IntegrationsModule` собирает модули вместе.

Это границы внутри приложения, а не установка сторонних плагинов. Выключение платной
автоматизации и ручные операции сохраняют свои настройки.

## Разработка

```bash
docker compose -f infra/compose.dev.yaml up -d      # Postgres 18, Valkey 8, VictoriaMetrics
cp apps/api/.env.example apps/api/.env
pnpm install
pnpm dev                                            # api :3000 (+ /api/backend-tools/docs), web :5173
```

Dev API пишет в `apps/api/dist-dev`, релизная сборка — в `apps/api/dist`.
Кэши TypeScript разделены: `pnpm build` и `pnpm typecheck` не удаляют исполняемые
файлы работающего watch-процесса. На сервере по-прежнему запускается `dist/main`.

Требуются Node 24 и pnpm 11. При первом старте API печатает токен первого запуска — открой
http://localhost:5173/setup. Потерял токен: `pnpm --filter api cli setup-token`; остальные команды
rescue CLI: `pnpm --filter api cli --help`.

Проверки: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`; e2e бэкенда —
`pnpm --filter api test:e2e`. Фронт без бэкенда: `VITE_MOCK=1 pnpm --filter web dev`.

## Лицензия

Приватный проект. © LumaxDev.
