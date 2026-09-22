# NodeService

Самохостируемая панель управления парком VPN/прокси-серверов «под себя»:
инвентарь серверов, безопасный SSH-доступ и терминал прямо в браузере, живой
мониторинг с оценкой ёмкости, установка функций пресетами, авто-починка,
AI-ассистент и уведомления в Telegram (с прокси-фолбэком).

> Статус: **реализация, этап 0–1** (каркас монорепо, авторизация). План по этапам —
> [`docs/implementation-plan.md`](docs/implementation-plan.md), спецификация —
> [`docs/architecture.md`](docs/architecture.md), требования — [`docs/requirements.md`](docs/requirements.md).

## Что это

Один хозяин (ты), десятки+ серверов. Панель — «пульт управления»: тёмная,
аккуратная, с графиками и удобными тумблерами. На каждой ноде — крошечный агент
(Go), который сам звонит панели по защищённому каналу, шлёт метрики и выполняет
команды. SSH — запасной путь для первичной установки и ручного терминала.

## Структура (этот репозиторий — панель)

```
panel/                # монорепо pnpm + Turborepo, всё запускается через Docker Compose
├── apps/api          # backend (NestJS + TypeScript): API, сессии, журнал, агенты, терминал
├── apps/web          # frontend (React + Vite + TypeScript, Tailwind v4, shadcn/ui)
├── packages/shared   # общие контракты (zod-схемы API, протокол панель↔агент)
├── infra/            # Docker Compose (prod + dev), Caddy, установка одной командой
├── design/           # живой демо-макет (preview.html) — эталон UI
├── docs/             # архитектура, требования, план реализации
└── .github/          # CI: lint, typecheck, tests, сборка образов
```

Агент для нод — отдельный репозиторий `nodeservice-agent` (папка `../agent`
рядом): Go, свои релизы, ставится на сервер из релизов по SSH.

## Запуск (разработка)

```bash
export PATH="/opt/homebrew/opt/node@24/bin:$PATH"   # Node 24 LTS + pnpm 11
docker compose -f infra/compose.dev.yaml up -d      # Postgres 18, Valkey 8, VictoriaMetrics
cp apps/api/.env.example apps/api/.env
pnpm install
pnpm dev                                            # api :3000 (+ /api/backend-tools/docs), web :5173
```

При первом старте API печатает **токен первого запуска** — открой http://localhost:5173/setup.
Потерял токен: `pnpm --filter api cli setup-token`. Rescue CLI: `pnpm --filter api cli --help`.

Всё, что происходит в панели, пишется в **Журнал** (http://localhost:5173/audit): вход, настройки,
системные события — с IP, браузером и diff изменений; live-лента, экспорт CSV/JSON. Хранение —
`AUDIT_RETENTION_MONTHS` в `.env` (по умолчанию 12 месяцев), записи из приложения неизменяемы.

Проверки: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`;
e2e бэкенда: `pnpm --filter api test:e2e`; скриншоты всех экранов: `node scripts/screenshots.mjs`;
состояния, недостижимые в обычном сценарии (step-up, старые коды) — `node scripts/mock-shots.mjs` (MSW-моки).

Прод: `cp infra/.env.example infra/.env` (заполнить), `docker compose -f infra/compose.yaml up -d`.

## Дорожная карта

Строим снизу вверх — каждый следующий модуль встаёт на готовый фундамент.
Подробно: [`docs/roadmap.md`](docs/roadmap.md).

1. **Фундамент (MVP)** ← сейчас: сервера + SSH + терминал + базовый мониторинг
2. Пресеты установки + тумблеры (web-proxy, нода)
3. Оценка ёмкости («сколько юзеров влезет»)
4. Авто-починка (правила «симптом → действие → проверка»)
5. AI-ассистент (анализ логов/метрик, объяснения)
6. Уведомления (Telegram + прокси-фолбэк)

## Дизайн

Тёмная графитовая тема, скруглённые блоки, плавные симметричные перестроения,
ничего не вылезает за рамки. Живой макет: [`design/preview.html`](design/preview.html).

## Лицензия

Приватный проект. © LumaxDev.
