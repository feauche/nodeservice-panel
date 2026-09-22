# NodeService — план реализации (этапы 0 → 11)

Дата: 2026-08-29 · Источник: research по 8 темам (монорепо/тулинг, фронт, бэкенд, auth, журнал аудита, дизайн-система, инфра/деплой, Go-агент) с проверкой того, как это делают Remnawave, Dokploy, Coolify, Portainer, Beszel, NetBird, Pangolin, Marzban, плюс OWASP/NIST. У каждого этапа: цель → что появляется → «как делают профессионалы» → **что улучшаем** (только там, где research показал реально лучший подход; если очевидный путь и так правильный — раздел пропущен) → чекпоинт для проверки.

Принцип работы: **постранично** — каждая страница/модуль проверяется по чекпоинту сразу после реализации, потом следующая. Всё запускается через Docker Compose (прод и разработка).

## 0. Решения по стеку (окончательно)

| Слой | Выбор | Почему | Отклонено |
|---|---|---|---|
| Runtime / package manager / monorepo | Node.js 24 LTS (engines >=24.4), pnpm 10.x (поле packageManager + pnpm/action-setup в CI), чистые pnpm workspaces без Turborepo/Nx | Node 24 — Active LTS до 04/2028, именно его таргетят Dokploy (^24.4.0) и remnawave/backend (>=24.18). Dokploy работает на голых pnpm workspaces с 2 приложениями и это достаточно для panel+web+2 shared-пакетов. Corepack удалён из Node 25+, поэтому pnpm ставится явно (action-setup / npm i -g), а не через corepack. | Node 22 (Maintenance LTS), Node 26 (ещё Current); Turborepo (добавить позже только при реальной боли с кешем), Nx (enterprise-инструмент для multi-team); npm/yarn (нет pnpm deploy для чистого Docker-слоя) |
| Линтер / форматтер / хуки | Biome 2.x (пин точной версии через -E) как единый линтер+форматтер; Lefthook для git-хуков | Biome — один инструмент вместо ESLint+Prettier, используется Dokploy (2.5.7) с autofix-ci в PR. Lefthook — Go-бинарник без node_modules, что важно для монорепо с Go-агентом: Go-контрибьютору не нужен Node, чтобы закоммитить. | oxlint+oxfmt (remnawave; oxfmt ещё pre-1.0, два инструмента); ESLint+Prettier (медленнее, больше конфигов); Husky+lint-staged (требует Node для хуков) |
| Backend framework | NestJS 11.2.x + @nestjs/platform-express | Ближайший доменный аналог remnawave/backend — NestJS 11.2.1 на Express. DI/модули дают готовую архитектуру соло-разработчику. NestJS 12 вышел 27.08.2026 — экосистема (nestjs-zod, bullmq, throttler-storage) под него не проверена; мигрировать позже. Express — зрелая экосистема middleware (csrf-csrf, helmet, ssh2-стриминг); throughput для single-admin панели не критичен. | NestJS 12 (2 дня с релиза), Fastify-адаптер (RPS не нужен, меньше проверенных интеграций), Hono/голый Fastify (нет DI/модулей), AdonisJS (привязка к Lucid/VineJS, нет аналогов в домене) |
| База данных / ORM | PostgreSQL 18 (postgres:18-alpine, минор запинен); Prisma 6.x как основной ORM + Kysely 0.28.x для сложных типобезопасных запросов (audit-поиск, keyset-пагинация, отчёты); pg_partman 5.4.x для партиций audit_log | PG18 даёт uuidv7(), virtual generated columns (tsvector для поиска по Журналу), async I/O. Prisma+Kysely — ровно связка remnawave/backend: Prisma для миграций/CRUD/Studio, Kysely там где нужен полный контроль над SQL (партиции, tsquery, cursor-пагинация). | PG17 (устарел относительно 18.6 на 08/2026); Drizzle (валиден, но его преимущества — edge/bundle size — не применимы к self-hosted VPS; нет доменного референса); только Prisma (слабо для партиций/FTS) |
| Валидация / конфиг | zod 4.x + nestjs-zod 5.x везде (DTO, env через ConfigModule.forRoot({validate}), контракты агента); без class-validator | Прямой прецедент remnawave/backend (zod 4.4.3 + nestjs-zod 5.5.0, class-validator отсутствует). Единая библиотека на backend и frontend (react-hook-form zodResolver), forward-compatible с NestJS 12 Standard Schema. | class-validator/class-transformer (декораторный дубль типов, смешение с zod — антипаттерн); Joi только для env (вторая библиотека) |
| API-контракт | @nestjs/swagger 11.x (спека) + @scalar/nestjs-api-reference (UI) + Orval 8 для генерации TanStack Query хуков и zod-схем во frontend | Backend REST+OpenAPI — естественный источник правды; Orval генерирует готовые хуки под TanStack Query v5, закрывая связку «поменял DTO → фронт получил типы» без ручного дублирования. Scalar — как у remnawave. | tRPC (требует RPC-слой вместо REST/OpenAPI, ломает Swagger и Go-клиентов); ts-rest (contract-first с нуля, лишний слой); ручные типы |
| Логирование / ошибки | nestjs-pino + pino (JSON, redact) с request-id через nestjs-cls; единый exception filter в формате RFC 9457 problem+json; события аудита — отдельная таблица (не логи) | request_id связывает pino-логи и записи Журнала. Разделение operational logs (stdout, короткий retention) и audit DB (долгий retention, UI) — паттерн Coolify/Vercel. | встроенный ConsoleLogger (без структурированного JSON); winston (тяжелее, хуже с NestJS) |
| Очереди / кэш / сессии | Valkey 8.x (образ valkey/valkey:8-alpine) + BullMQ 6.x + @nestjs/bullmq 11.x + ioredis 5.x (для BullMQ и сессий) + @bull-board/nestjs | BullMQ 6 — актуальная стабильная ветка (6.3.x), как у remnawave. Valkey — BSD-3, drop-in для ioredis. ioredis остаётся самой протестированной связкой с BullMQ, хотя переведён в maintenance — один клиент на всё проще, чем два. | BullMQ 5 (устарел); Redis 8 (годится, но лицензионная история менее предсказуема для будущего OSS); node-redis для сессий + ioredis для BullMQ (два клиента); express-session as-is (нет revoke-all/amr-флагов) |
| Аутентификация | argon2 (argon2id, явные параметры OWASP) + otplib (TOTP) + qrcode; сессии — собственный тонкий слой в Valkey (opaque id, __Host- cookie, sliding TTL, amr/step_up_verified_at); csrf-csrf (signed double-submit); rate-limiter-flexible поверх Valkey; helmet; nest-commander для rescue CLI; @simplewebauthn (passkeys) — позже | Требования ТЗ (2FA, trusted device, step-up, setup-token, rescue CLI) выше, чем у remnawave (scrypt, без TOTP). Кастомный слой сессий даёт список/отзыв сессий и MFA-флаги; csurf deprecated. | bcrypt (ниже argon2id по OWASP); @node-rs/argon2 (равноценно, брать если сломается prebuild под arm64); JWT-only (нельзя отозвать); csurf (deprecated); better-auth (не NestJS) |
| Realtime | Голый ws (NestJS WsAdapter) для агента и терминала; SSE (@Sse) для односторонних обновлений (live-лента Журнала, статусы нод) | Socket.IO — отдельный протокол, неудобный для Go-агента и xterm байтового потока. SSE — auto-reconnect в браузере, Last-Event-ID, без библиотек. | socket.io (Engine.IO на Go — лишний слой); WebSocket для всего (двойная работа по reconnect в браузере) |
| Frontend | React 19.2 + Vite 7 SPA, TanStack Router (codegen routeTree), TanStack Query v5 + Orval-клиент, Zustand 5 (auth/UI/тема), react-hook-form 7 + zod 4 + @hookform/resolvers 5, react-i18next (ru с первого дня), lucide-react, motion (motion/react) | Панель за auth, SEO не нужен — SPA проще Next.js. TanStack Router даёт типобезопасные search-params (фильтры Журнала, вкладки нод). Стек Zustand+TanStack Query+i18next подтверждён remnawave/frontend. | Next.js (SSR без ценности, сложнее деплой); Vite 8/Rolldown (свежий мажор, обновиться позже); React Router 7/8 (нет типизации search-params); Redux Toolkit/Jotai (избыточно/точечно); framer-motion (старый импорт) |
| UI-кит / темы | Tailwind CSS 4.x + shadcn/ui CLI с явным `-b radix` (unified пакет radix-ui), tw-animate-css, sonner, cmdk, react-rnd (окно терминала), next-themes с attribute=data-theme и темами light/dark/black, @fontsource (Archivo, IBM Plex Sans/Mono), кастомные SVG-компоненты для sparkline/ring gauge/world map | Зафиксировано ТЗ (Tailwind v4 + shadcn + Radix). С 07/2026 shadcn по умолчанию ставит Base UI — флаг -b radix обязателен, иначе смесь asChild/render. Три темы требуют data-атрибута, не класса .dark. Радиусы 16/10/6 — именованные токены, не пропорциональная шкала shadcn. Прямой порт SVG из демо сохраняет пиксель-парность. | Base UI (ТЗ требует Radix); Mantine (remnawave, но противоречит ТЗ); Recharts/ECharts для демо-графиков (ломают 1:1 с демо; Recharts оставить для аналитических графиков позже); tailwindcss-animate (несовместим с v4) |
| Тестирование | Vitest 4 (unit backend+frontend) + @testing-library/react + MSW 2; @testcontainers/postgresql + Valkey-контейнер для интеграционных тестов backend; Playwright для 3–5 критичных E2E; Storybook 9 только для src/shared/ui | Vitest быстрее Jest и уже стандарт (Dokploy vitest 4); один test-runner на весь монорепо; NestJS 12 сам движется к Vitest. Testcontainers дают честные тесты миграций/партиций/Kysely-запросов вместо моков Prisma. remnawave без тестов — не копировать. | Jest (медленнее, дублирующий раннер); моки Prisma (не ловят SQL-ошибки); Cypress (тяжелее Playwright) |
| Go-агент | Go 1.25, coder/websocket, spf13/cobra, gopsutil/v4, cenkalti/backoff v7, zerolog, gRPC-клиент Xray StatsService из официального .proto, self-update через ed25519 (crypto/ed25519) поверх канала к панели, systemd unit с hardening | gorilla/websocket заброшен (архив 12/2022). Агент-инициируемый WS без входящих портов — модель Beszel/NetBird. Энроллмент — одноразовый токен + пиннинг ed25519-ключа агента (TOFU), а не свой CA с mTLS. | gorilla/websocket (discontinued); mTLS с собственным CA (PKI-нагрузка на соло-админа); protobuf с первого дня (преждевременно, JSON с версионированным конвертом); minio/selfupdate (избыточен для бинарей 10–20 МБ); чистый SSH без агента (Coolify-модель не даёт push-метрик) |
| Инфраструктура / деплой | Docker Compose (caddy, panel, web-static внутри panel-образа или отдельный, postgres:18, valkey, victoriametrics single-node), Caddy 2.11 (auto-HTTPS, WS/SSE из коробки), multi-stage Dockerfile на node:24-slim (Debian, не alpine) с pnpm deploy, GHCR публичные образы через docker/build-push-action, install.sh по паттерну Coolify, `nodeservice update` вместо Watchtower, restic+pg_dump для бэкапов, Diun для уведомлений | remnawave/backend осознанно использует node:24-trixie-slim из-за нативных биндингов (argon2, Prisma). Watchtower архивирован 12/2025. Публичные образы избавляют install.sh от docker login. | alpine-образы (musl vs нативные модули); Watchtower (archived); nginx/traefik (Caddy проще с auto-HTTPS); distroless (усложняет entrypoint с миграциями); Redis (см. выше) |

**Осознанные отступления от research (решение 2026-08-29):**

1. **ORM — Drizzle ORM (drizzle-kit для миграций), а не Prisma + Kysely.** Research предлагал связку «как у Remnawave». Для соло-разработчика один инструмент лучше двух: Drizzle даёт типобезопасный SQL (keyset-пагинация, tsvector-поиск, партиции через raw SQL-миграции) и миграции в одном пакете; доменный референс есть — Dokploy живёт на Drizzle + Postgres. Если упрёмся — Kysely добавляется точечно.
2. **Заголовочный шрифт — Golos Text, а не Archivo.** У Archivo нет кириллицы: в демо русские заголовки рисовались системным шрифтом-подменой. Golos Text — гротеск, спроектированный под русский, с латиницей того же характера; IBM Plex Sans/Mono остаются.
3. **Turborepo оставляем** поверх pnpm workspaces (research: «достаточно голых workspaces»). Он уже настроен, даёт кеш typecheck/test/build бесплатно, конфликтов не создаёт.
4. **Vite 8** уже стоит и собирает проект (плагины TanStack Router и Tailwind работают). Research советовал 7.x как более обкатанный; откатимся только если упрёмся в несовместимость плагинов.
5. **NestJS 11.2 (Express)** — как советует research: 12-я вышла 27.08.2026, экосистема (nestjs-zod, bullmq, throttler) под неё не проверена. Миграция на 12 — в бэклог после этапа 11.

## 1. Структура репозитория панели

Два независимых репозитория: `panel/` (этот) и `agent/` (Go, свои релизы; панель ставит его на серверы из GitHub Releases по SSH).

```
panel/
├── package.json · pnpm-workspace.yaml · turbo.json · biome.json · lefthook.yml · tsconfig.base.json
├── .github/workflows/        # ci.yml (lint/typecheck/test/build), release.yml (тег → GHCR-образы + install.sh), e2e.yml
├── apps/
│   ├── api/                  # NestJS 11 + TypeScript
│   │   ├── src/main.ts       # bootstrap: helmet, pino, shutdown hooks, WsAdapter, Scalar docs
│   │   ├── src/cli.ts        # rescue CLI (nest-commander): create-admin, reset-password, disable-2fa, revoke-sessions, setup-token
│   │   ├── src/config/       # env.schema.ts (zod) + config.module.ts
│   │   ├── src/common/       # problem+json filter, interceptors, guards, decorators, cls (request-id, actor)
│   │   ├── src/infra/        # db (drizzle + pg), valkey (ioredis), queue (bullmq), ws-adapter, metrics (victoria)
│   │   ├── src/modules/      # auth, users, audit, security-settings, servers, agent-gateway, metrics, terminal, incidents, assistant, notifications, health, cli
│   │   ├── drizzle/          # schema.ts + migrations/ (в т.ч. raw SQL для партиций audit_log)
│   │   ├── test/             # integration (testcontainers), e2e
│   │   └── Dockerfile        # multi-stage node:24-slim, pnpm deploy, non-root, tini
│   └── web/                  # React 19 + Vite + TypeScript SPA
│       ├── src/routes/       # TanStack file-routes: login, setup, /, servers/$id, audit, settings/security, …
│       ├── src/features/     # auth/, audit/, servers/, overview/, terminal/, incidents/, assistant/, theme/
│       ├── src/components/ui # shadcn (Radix) — не править руками
│       ├── src/components/primitives # KpiTile, Sparkline, RingGauge, WorldMap, TerminalWindow, ConfirmDialog, CommandPalette — порт SVG из демо 1:1
│       ├── src/lib/          # api-клиент (Orval + TanStack Query), query-client, utils
│       └── src/index.css     # токены трёх тем (data-ns-theme) → переменные shadcn
├── packages/shared/          # zod-схемы API, enum-ы аудита, протокол панель↔агент (v1)
├── infra/                    # compose.yaml (prod), compose.dev.yaml, caddy/Caddyfile, scripts/install.sh, update.sh
├── design/preview.html       # живой эталон UI
└── docs/                     # architecture, requirements, implementation-plan, design-refs, ADR
```

## 2. Этапы

### Этап 0 — Фундамент: монорепо, тулинг, CI, compose

**Оценка:** 2–3 дня

**Цель.** Пустая, но полностью «профессиональная» оболочка: pnpm workspaces, оба приложения стартуют, lint/typecheck/test проходят локально и в CI, compose поднимает postgres/valkey/victoriametrics/caddy, есть Dockerfile и health-эндпоинт.

**Что появляется:**
- package.json (root), pnpm-workspace.yaml, packageManager pnpm@10.x, engines node >=24.4
- biome.json (pinned -E), lefthook.yml, tsconfig.base.json, packages/config, packages/shared (пустой каркас zod-схем)
- apps/panel: NestJS 11 skeleton, main.ts (helmet, nestjs-pino, enableShutdownHooks, RFC 9457 filter), config/env.schema.ts (zod), infra/prisma + kysely providers, modules/health (@nestjs/terminus: db, valkey, disk, memory), Scalar на /api/docs
- apps/web: Vite 7 + React 19 + TanStack Router, Tailwind v4 + shadcn init -b radix, styles/globals.css с токенами 3 тем (data-theme light/dark/black), радиусы --radius-card/control/chip 16/10/6, @fontsource шрифты, next-themes + anti-FOUC inline script, orval.config.ts, vitest + testing-library + MSW setup
- infra/docker-compose.yml (postgres:18.6-alpine, valkey:8, victoriametrics v1.146.0, caddy:2.11 — без ports у внутренних сервисов, healthchecks, depends_on: service_healthy, logging max-size/max-file, mem_limit), Caddyfile (reverse_proxy /api → panel, статика web), .env.example
- apps/panel/Dockerfile (multi-stage node:24-slim, pnpm deploy --filter panel --prod, non-root, tini)
- .github/workflows/ci.yml (pnpm/action-setup@v5 + setup-node@v5 cache pnpm, matrix.job lint|typecheck|test|build; отдельный go-job заглушка), format.yml (autofix-ci), renovate.json
- docs/ADR-001-stack.md

**Как делают профессионалы.** Dokploy: pnpm workspaces без Turborepo, Biome 2.x + autofix-ci в PR, CI-матрица по задачам (не по версиям Node), pnpm install --frozen-lockfile. remnawave/backend: zod-валидация env через @nestjs/config, Scalar вместо Swagger UI, terminus health, Dockerfile на node:24-trixie-slim. Pangolin compose: healthcheck + depends_on condition: service_healthy. Coolify: публичные GHCR-образы.

**Что улучшаем (по research):**
- Не брать shadcn по умолчанию — с 07/2026 CLI ставит Base UI; инициализировать `shadcn init -b radix` и сразу использовать unified пакет `radix-ui`, иначе получите смесь asChild/render.
- Темы через data-theme на <html> (next-themes attribute="data-theme", themes=[light,dark,black]) + `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *))`; Tailwind v4 по умолчанию использует prefers-color-scheme, и .dark-класс не покрывает третью тему.
- Радиусы 16/10/6 объявить именованными токенами, а не через пропорциональную шкалу shadcn (--radius → sm/md/lg в процентах) — иначе демо не совпадёт.
- Lefthook вместо Husky: Go-контрибьютор в agent/ не должен ставить Node ради коммита.
- В Dockerfile использовать node:24-slim (Debian), не alpine — argon2/Prisma нативные биндинги ломаются на musl (remnawave сознательно на trixie-slim).
- Явно задать logging max-size/max-file и mem_limit на каждый сервис compose — json-file без ротации забивает диск VPS; deploy.resources.limits вне Swarm ненадёжен.
- Vitest один на весь монорепо (в т.ч. для NestJS), не Jest — NestJS 12 сам уходит на Vitest, а два раннера — лишняя нагрузка.

**Чекпоинт (как проверяем):** `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build` зелёные локально и в CI; `docker compose up` в infra/ → все сервисы healthy, https://localhost/api/health отдаёт ok, https://localhost/ показывает пустую страницу с переключателем трёх тем без FOUC и корректными шрифтами/радиусами.

### Этап 1 — Login, 2FA, первый запуск + backend auth

**Оценка:** 5–7 дней

**Цель.** Полный цикл входа единственного администратора: setup-token → создание админа → логин (пароль) → TOTP → сессия в Valkey; trusted device, step-up, rescue CLI. Страницы пиксельно по демо.

**Что появляется:**
- Prisma: users (password_hash argon2id, totp_secret_enc, totp_enabled), recovery_codes (hash, used_at), trusted_devices, setup_tokens (hash, used_at); миграции
- modules/auth: SessionStore (Valkey hash, opaque id, sliding TTL, amr, step_up_verified_at, list/revoke), argon2 (type argon2id, memoryCost/timeCost/parallelism явно), otplib+qrcode (otpauth:// issuer NodeService), AES-256-GCM шифрование TOTP-секрета с версионированным ключом (env AUTH_ENC_KEY_V1), recovery-коды через argon2, csrf-csrf (X-CSRF-Token), rate-limiter-flexible (IP+login прогрессивно, IP суточный cap), TrustedDeviceService (__Host-trusted_device, 30 дней, привязка к UA-хэшу), StepUpGuard (TTL 5 мин), SetupTokenService (печать в лог при первом старте, хэш в БД, одноразовый)
- Cookie __Host-sid Secure/HttpOnly/SameSite=Strict/Path=/
- modules/cli (nest-commander): create-admin, reset-password, disable-2fa, revoke-all-sessions, rotate-setup-token — запуск через docker exec
- apps/web: routes /setup, /login, /login/2fa, /settings/profile (заготовка); features/auth (Zustand auth-store, react-hook-form+zod формы, SessionGuard в роутере), генерация Orval-клиента для auth API
- Тесты: unit (totp, session store, rate limiter), integration с testcontainers (setup → login → 2fa → session), Playwright: happy path логина
- Аудит-хуки: пока временный вызов logger'а; в Stage 2 переводится на AuditService

**Как делают профессионалы.** Beszel/Portainer: one-time setup при первом запуске; Dokploy: better-auth twoFactor (TOTP SHA-1/30s/±1 window) — с известным багом при ротации ключа шифрования (issue #3645). remnawave: passkeys через @simplewebauthn, но без TOTP и rate-limit — образец слабее ТЗ. OWASP Password Storage / MFA / Session Management cheat sheets — базовые параметры.

**Что улучшаем (по research):**
- TOTP-секрет — обратимо зашифрован (AES-GCM) с версией ключа в записи (key_version), recovery-коды — необратимо хэшированы; ротация ключа обязана делать re-encrypt (урок Dokploy #3645).
- Не полагаться на дефолты argon2: задать параметры явно (m=64MiB,t=3,p=4 или OWASP-профиль), иначе смена библиотеки незаметно меняет стойкость.
- Setup-токен без истекающего таймера (антипаттерн Portainer — 5 минут и рестарт), но одноразовый и хэшированный в БД.
- SameSite не заменяет CSRF-токен — использовать csrf-csrf с подписанным double-submit, csurf deprecated.
- Trusted-device пропускает только TOTP при логине, но не отменяет step-up для смены пароля/отключения 2FA/revoke sessions.
- HIBP k-anonymity проверка пароля при установке (опционально, feature-flag) — 5 символов SHA-1, Add-Padding: true.

**Чекпоинт (как проверяем):** Свежий compose-стек: setup-токен в логах → создан админ → логин+TOTP → сессия видна в Valkey; неверный пароль ×5 → 429 с растущей блокировкой; `docker exec panel node dist/cli.js disable-2fa` работает; Playwright login проходит; страницы совпадают с демо во всех трёх темах.

**Дополнено после проверки пользователем (2026-08-29):** inset-каркас, три различимые темы, экран блокировки без дублей, подтверждение выхода, раздел «Настройки» с верхними вкладками (Внешний вид, Безопасность), выравнивание шапки, статичный favicon, а также **модуль настроек внешнего вида** — свой логотип по прямой ссылке и название с цветовыми кодами `[#rrggbb]`/`[#accent]` (контракт в `packages/shared/src/settings.ts`, API `modules/settings`, хранение в `app_meta.settings.appearance`, web `features/settings/brand-card.tsx`). Всё покрыто тестами (shared 3, api e2e 23, web 66) и скриншотами 12–13.

### Этап 2 — Журнал (audit log): всё логируется, страница с фильтрами, live-лентой и экспортом

**Оценка:** 5–6 дней

**Цель.** Append-only партиционированная таблица аудита, декларативный захват всех мутаций и auth-событий, страница Журнала с keyset-пагинацией, поиском, SSE live tail и экспортом CSV/JSON.

**Что появляется:**
- SQL-миграция (raw, поверх Prisma): audit_log PARTITION BY RANGE (occurred_at) помесячно, pg_partman (premake 3), колонки id uuidv7, seq bigint identity, actor_type/id/display, action ('auth.login.failed', 'server.create'), category enum, target_type/id/display, result, severity, ip inet, user_agent, request_id, before/after jsonb (только diff), metadata jsonb, search tsvector generated + GIN; роль приложения только INSERT+SELECT (грант шаблон для новых партиций); опционально prev_hash/hash
- modules/audit: @Audit(category, action, {except:[...]}) декоратор, AuditInterceptor (tap/catchError, длительность, санитизация body), AuditService.record (outbox: в той же транзакции при наличии, иначе очередь BullMQ с retry), actor из CLS (request.user), явные вызовы для фоновых джобов/guard-отказов (chokepoint в AuthGuard и exception filter), EventEmitter 'audit.created'
- audit.repository.ts (Kysely): keyset (occurred_at,id) < cursor, websearch_to_tsquery, фильтры category/actor/result/date; audit.sse.controller.ts (@Sse, heartbeat 20 с, Last-Event-ID); export.controller (stream pg-copy-streams CSV/JSON) + BullMQ job для больших диапазонов; retention job (DETACH/DROP partition старше N месяцев, опционально архив)
- packages/shared: enum'ы AuditAction/Category (используются и во фронте для i18n-лейблов)
- apps/web: route /audit с typed search-params (TanStack Router): таблица @tanstack/react-table + @tanstack/react-virtual, панель фильтров (date range default 7 дней, multiselect actor/category/result, поиск), раскрывающаяся панель деталей (IP/UA/request_id, before/after diff), переключатель Live (EventSource, подсветка новых строк), кнопка Export
- Перевод всех событий Stage 1 на AuditService (login success/failed/denied, 2fa enable/disable, session revoke, setup complete, trusted device add/remove)
- Тесты: integration (testcontainers) на append-only грант, партиции, keyset-пагинацию, redaction; unit interceptor

**Как делают профессионалы.** Coolify PR #9842: отдельный audit-канал, единые chokepoints для auth/authz-отказов + explicit auditLog() в мутирующих операциях, LOG_AUDIT_DAYS retention. GitHub org audit log: qualifiers actor/action/operation, CSV/JSON экспорт с лимитами. Vercel: разделение Activity vs immutable Audit log с IP/UA/before-after. Portainer: Activity log с фильтрами по дате/пользователю/действию и CSV. nestbolt.io: @Audit декоратор + interceptor + AsyncLocalStorage actor.

**Что улучшаем (по research):**
- Денормализовать actor_display/target_display на момент события — иначе после переименования/удаления ноды Журнал показывает 'Unknown' (GitHub/Vercel хранят снапшот имени).
- Только keyset-пагинация (occurred_at,id), никакого OFFSET — на миллионах строк деградирует и «прыгает» при вставках.
- Retention через DROP PARTITION, а не DELETE; pg_partman с premake, иначе INSERT в новый месяц упадёт без партиции.
- Хранить в before/after только изменённые поля и никогда не писать секреты даже маскированно — только факт изменения (password_changed: true); отдельный except-список на декораторе, т.к. pino redact не касается JSONB.
- Запись аудита не fire-and-forget: outbox в транзакции или BullMQ с ретраями — иначе дыры в Журнале при падении процесса.
- Hash-chain — опционально и с честной оговоркой в docs/threat-model.md: единственный админ = суперпользователь БД, без внешнего якоря это не tamper-proof.
- SSE: heartbeat-комментарии каждые 15–30 с и Cache-Control: no-cache; проверить, что Caddy не буферизует; HTTP/2 в Caddy снимает лимит 6 соединений на домен при нескольких вкладках.

**Чекпоинт (как проверяем):** После любого действия из Stage 1 запись появляется в /audit в течение секунды (Live включён); фильтр по category+поиск 'login' возвращает корректные страницы через cursor; попытка UPDATE audit_log от роли приложения → permission denied; экспорт 50k строк в CSV стримится без роста памяти; тест: партиция на следующий месяц существует.

**Итог этапа 2 (2026-08-29): сделано.** Отклонения от плана выше — осознанные:
- **Пагинация номерная** (‹ 1 2 … N ›, новые сверху, размер страницы по высоте экрана) — так просил пользователь (требование 13.3); keyset используется там, где он нужен реально: догон SSE по `seq` и потоковый экспорт. `COUNT(*)` по фильтру для панели одного админа — миллисекунды; порог пересмотра — десятки миллионов строк.
- **Без pg_partman** (его нет в `postgres:18-alpine`): разделы создаёт сам сервис — при старте и ежедневно (`@nestjs/schedule`, 03:17), на 2 месяца вперёд; если раздела нет в момент вставки — создаётся на лету и вставка повторяется. Ретеншн — `DROP TABLE` раздела старше `AUDIT_RETENTION_MONTHS`.
- **Без BullMQ-outbox**: запись синхронная (интерсептор и auth ждут insert до ответа), при недоступности БД — ограниченная in-memory очередь повторов (1000 записей, каждые 5 с) + ошибка в лог. Действие пользователя из-за Журнала не падает.
- **Без hash-chain**: единственный админ = суперпользователь БД, без внешнего якоря это не защита. Append-only обеспечивают триггеры BEFORE UPDATE/DELETE/TRUNCATE (наследуются разделами).
- **Drizzle вместо Kysely**; `audit_log` описана вручную (`modules/audit/audit.table.ts`) и не входит в схему drizzle-kit — партиционированные таблицы и триггеры kit не генерирует.
- `id` — `uuidv7()` (нативно в PostgreSQL 18), `seq` — identity для Last-Event-ID и стабильного порядка.
- Тесты: api e2e 11 (запись событий входа, `@Audit` с diff и failed-веткой, фильтры/поиск/пагинация, append-only, партиции/ретеншн/создание на лету, очередь повторов, SSE-события, экспорт), web 6 (страница, пагинация, фильтры, детали, пустое состояние, утилиты), shared 3. Live-лента через настоящее SSE проверяется скриптом `scripts/screenshots.mjs` (второй вкладкой).

### Этап 3 — Страница настроек безопасности

**Оценка:** 3 дня

**Цель.** Управление 2FA (включить/выключить, recovery-коды), активные сессии (список, revoke, revoke all), доверенные устройства, смена пароля, политики (таймаут сессии, rate-limit параметры, allowlist IP для панели), просмотр setup-состояния — всё за step-up.

**Что появляется:**
- modules/security-settings: settings-таблица (singleton row, zod-схема), endpoints GET/PATCH, sessions list/revoke, trusted-devices list/revoke, 2fa enable (QR) / confirm / disable / regenerate recovery
- StepUpGuard на все мутации; каждая мутация — @Audit(security.*)
- apps/web: route /settings/security с секциями (Password, Two-factor, Sessions, Trusted devices, Policies, IP allowlist), StepUpDialog (пароль или TOTP) как переиспользуемый компонент в components/primitives, ConfirmDialog на AlertDialog для деструктивных действий, sonner-тосты
- Playwright: включение 2FA с recovery-кодами и revoke-all-sessions (текущая сессия сохраняется)

**Как делают профессионалы.** OWASP MFA cheat sheet: re-auth перед сменой пароля/email/отключением MFA. GitHub/Vercel settings: список сессий с UA/IP/last seen, revoke. Dokploy: страница 2FA с QR и backup codes.

**Улучшения:** очевидный подход здесь правильный — ничего не добавляем.

**Чекпоинт (как проверяем):** Все операции требуют step-up (истёкший step-up → 403 problem+json, UI открывает StepUpDialog); revoke-all оставляет текущую сессию; каждое изменение видно в Журнале с before/after без секретов.

**Итог этапа 3 (2026-08-29): сделано.** Отклонения и решения:
- **Политика в БД** (`app_meta.settings.security`), а не в env: idle-таймаут сессии меняется из панели и действует сразу (кэш 5 с в `SecurityPolicyStore`; `SESSION_IDLE_MINUTES` в env — стартовое значение). **Умолчания по просьбе пользователя: сессия 6 ч, блокировка экрана через 30 мин — серверная** (`SessionRecord.lockedAt`, `SessionGuard` пускает только `/api/auth/*`, `POST /auth/lock`), клиентский `useIdleLock` только дублирует по активности. Причина серверной: клиентская блокировка не действует в новой вкладке и обходится закрытием страницы.
- **Step-up** — серверный guard + один диалог на фронте с автоповтором запроса; смена пароля step-up не требует: текущий пароль и есть подтверждение (и защищён тем же throttle, что и вход).
- **Проверка пароля по утечкам** — HIBP range API (k-anonymity), fail-open при недоступности сети, выключается `PASSWORD_LEAK_CHECK=false`. Пароль из утечек отклоняется, а не «предупреждается» — так делает GitHub.
- **Перевыпуск 2FA двухфазный**: новый секрет живёт в Valkey 10 минут, старый работает до подтверждения кодом (нельзя остаться без 2FA из-за закрытой вкладки); 5 неверных кодов — начать заново. Подтверждение сбрасывает запомненные устройства и другие сессии.
- **Сессии наружу — отпечаток** (`sha256(sid)[:16]`), не токен; текущую через список завершить нельзя (есть «Выйти»).
- **IP allowlist перенесён на этап 11** (Caddy `remote_ip` + приложение + Rescue CLI `clear-allowlist` одним куском — иначе легко запереть себя); тумблер Telegram — на этап 10.
- Тесты: api e2e 8 (в т.ч. anti-replay TOTP и TTL сессии в Valkey), web 9 (в т.ч. step-up с отменой), shared 2.

### Этап 4 — Инвентарь серверов + добавление сервера

**Оценка:** 3–4 дня

**Цель.** CRUD серверов (нод) с enrollment-токенами и bootstrap-скриптом; страница списка и мастер добавления; статус 'ожидает агента'.

**Что появляется:**
- Prisma: servers (name, host, tags, location/geo, status enum, agent_pubkey, agent_version, last_seen_at, xray config ref), enrollment_tokens (hash, expires_at, max_uses, uses, revoked_at)
- modules/servers (CQRS-lite: commands/ create/update/delete/rotate-token, queries/ list/get, events/ ServerCreated…), генерация install-agent.sh с токеном (curl | bash), опциональный SSH-bootstrap через ssh2 (пароль/ключ) для автоматической установки
- apps/web: route /servers (таблица с тегами/статусом/поиском, typed search-params), /servers/new (wizard: данные → способ установки: скрипт | SSH → ожидание подключения через SSE), /servers/$id (skeleton, наполняется в Stage 6)
- packages/shared: zod-схемы server DTO для Orval и агента
- Аудит: server.create/update/delete, enrollment.token.create/revoke/use

**Как делают профессионалы.** NetBird setup-keys: TTL (7 дней по умолчанию), лимит использований, мгновенный отзыв. Beszel: токен подписан hub'ом, агент пиннится по fingerprint. Remnawave: ноды регистрируются в панели, продолжают работать при офлайн-панели. Coolify: SSH-подключение к серверу как альтернатива агенту.

**Что улучшаем (по research):**
- Токен энроллмента одноразовый/с лимитом и TTL, хранится хэшированным; при использовании привязывается публичный ключ агента (TOFU-пиннинг) — вместо приватной PKI/mTLS (NetBird/Beszel-модель).
- Ждать подключения агента через SSE в мастере, а не polling — уже есть инфраструктура из Stage 2.

**Чекпоинт (как проверяем):** Создан сервер → сгенерирован скрипт с токеном → повторное использование токена после лимита отклоняется (и попадает в Журнал как denied); список фильтруется по тегу через URL; удаление требует ConfirmDialog + step-up.

**Итог этапа 4 (2026-08-31): сделано.** Отклонения и решения:
- **Пароль SSH не хранится вообще** (в плане был опционально): им ставится единый ed25519-ключ панели (Coolify-модель), ключ до «забывания» пароля проверяется реальным подключением. Свой ключ — шифрованный `ENCRYPTION_KEY`.
- **TOFU host key** с явным «Доверять новому» за step-up и записью в Журнал; смена адреса/пользователя сбрасывает отпечаток.
- **CQRS-lite и SSE-ожидание агента отложены**: агента ещё нет (этап 5), городить события вокруг CRUD из шести методов — оверинжиниринг. Enrollment-токены готовы (per-server, sha256, TTL 24 ч, одноразовые, новый отзывает старый).
- OpenSSH-энкодер ed25519 написан вручную (node:crypto отдаёт только PKCS8, ssh2 его не читает); e2e гоняются против встроенного ssh2.Server — герметично, без Docker.
- Найденные тестами баги: категория `server` отсутствовала в CHECK Журнала (миграция 0005); `.partial()` поверх zod-полей с `.default()` протаскивал `port: 22` в каждый PATCH — правило: у update-схем без дефолтов.

Доработки по замечаниям (31.08.2026, v0.4.1): фильтр тегов — выпадающий список вместо полосы чипов; «Дублировать» в меню карточки (имя `-2`/`-3`, мастер с предзаполнением, адрес вводится заново); кнопка «Проверить все» (клиентский веер по /check, ≤4 параллельно); step-up диалог поднят на слой z-100 — фикс «пароль позади подтверждения удаления»; моки серверов требуют step-up как реальный API.

Доработки (31.08.2026, v0.4.2): «Дублировать» мгновенный — POST /servers/:id/duplicate копирует запись (адрес, доступы, факты, отпечаток; agentStatus → not_installed), имя -2/-3 подбирает сервер; уникальность host:port снята (миграция 0006). Карточка сервера кликабельна (hover из демо: подъём 1px + рамка), настройки сервера — модалка с разделами «Общее»/«Подключение» и футером Удалить (квадрат) / Отмена / Дублировать / Сохранить; при ошибке валидации открывается нужный раздел. «Проверить все» видна и при одном сервере. Перетаскивание карточек: ручка ⠿ в углу (dnd-kit, как в Remnawave), сетка сохраняется, порядок хранится в servers.sort_order (миграция 0007), POST /servers/reorder, запись в Журнал (server.reordered); новые серверы — в конец, копия — сразу после оригинала.\n\nДоработки (31.08.2026, v0.4.3): в модалке сервера вместо «Отмены» (закрытие — крестик/Esc/клик мимо) — кнопка «SSH-терминал» (заглушка с тостом до этапа 7); призрак перетаскивания сделан пиксель-в-пиксель с карточкой (строка «проверено…», инертные кнопки в шапке) — текст больше не мигает при взятии/броске; drag = DragOverlay + исходник opacity-0 + dropAnimation 220мс (модель Remnawave), версия OpenAPI привязана к SHARED_VERSION (был захардкод 0.1.0).\n\n### Этап 5 — Go-агент + метрики

**Оценка:** 7–10 дней

**Цель.** Агент устанавливается одной командой, энроллится, держит исходящий WSS, шлёт метрики (CPU/RAM/disk/net bps+pps/conntrack/Xray stats) в панель → VictoriaMetrics, выполняет команды из аллоулиста, самообновляется.

**Что появляется:**
- agent/: cobra CLI (run, enroll, version, self-update), internal/transport (coder/websocket, JSON-конверт {v,type,id,ts,payload}, ping/pong, backoff v7 с cap 60s + jitter), internal/enroll (ed25519 keypair при первом старте, обмен токена на привязку, хранение ключа в /var/lib/nodeservice-agent), internal/metrics (gopsutil/v4, дельты для bps/pps, /proc/sys/net/netfilter/nf_conntrack_count с fallback), internal/xray (gRPC StatsService клиент из официального proto: QueryStats, GetSysStats, online users), internal/commands (реестр: xray.restart, xray.reload, agent.selfupdate, system.reboot — каждый с context timeout, стрим stdout чанками + exit code), internal/selfupdate (манифест от панели, sha256 + ed25519-подпись, atomic rename, systemd restart), zerolog
- deploy/nodeservice-agent.service (Restart=always, NoNewPrivileges, ProtectSystem=strict, ProtectHome, PrivateTmp, CapabilityBoundingSet минимальный, отдельный пользователь с фиксированным UID), install-agent.sh (скачивание бинаря под arch, проверка sha256, установка unit)
- goreleaser/CI: multi-arch (amd64/arm64) бинари в GitHub Release + манифест с подписью
- apps/panel modules/agent-gateway: WsAdapter на ws, аутентификация по pubkey-challenge, zod-валидация конверта (packages/shared/protocol), heartbeat-таймауты → статус offline, приём метрик → запись в VictoriaMetrics (Prometheus remote write / import), диспетчер команд с correlation id, все команды — в Журнал; modules/metrics: PromQL-запросы к VM
- modules/servers: фоновая автопроверка SSH (@nestjs/schedule): раз в 15 мин для серверов без online-агента, раз в час — с online-агентом (живость и метрики уже даёт heartbeat агента каждые 5–10 с); результат меняет sshOk/lastSshCheckAt, в Журнал — только смены состояния, не каждый прогон
- docs/protocol.md (версия 1, типы сообщений)
- Тесты: Go unit (metrics delta, command registry, enroll), integration панели с mock-агентом

**Как делают профессионалы.** Beszel: agent-initiated WS, ed25519 challenge-response, fingerprint pinning, никакого произвольного shell. NetBird: агент всегда сам коннектится к Management, setup-keys. Netdata ACLK: версионированные схемы протокола (JSON → protobuf при масштабе). Prometheus node_exporter/Telegraf: conntrack через sysctl-файлы. Remnawave/Marzban: Xray gRPC StatsService.

**Что улучшаем (по research):**
- coder/websocket, не gorilla/websocket (архив с 12/2022).
- Никогда не принимать shell-строку от панели — только реестр команд с версией; спроектировать сразу, ретрофит на проде болезненный (Beszel-модель).
- Поле v в конверте с первого сообщения — иначе смешанный парк при роллинг-апгрейде неразличим.
- Self-update: подпись бинаря ed25519 отдельно от TLS; ключ тот же, что подписывает энроллмент; атомарный rename и рестарт через systemd.
- Backoff с верхней границей и jitter — без него thundering herd после рестарта панели.
- Отдельный пользователь с фиксированным UID вместо DynamicUser=yes — агенту нужно владеть конфигами Xray.
- JSON с версионированным конвертом, protobuf — только если флот вырастет (Netdata перешёл на protobuf лишь на миллионах агентов).

**Чекпоинт (как проверяем):** На тестовой VPS `curl … | bash` ставит агент → сервер в панели переходит в online, метрики видны в VictoriaMetrics (vmui) с интервалом 5–10 с; отключение сети → offline через таймаут, восстановление → reconnect с backoff (видно в логах агента); команда xray.restart из панели исполняется, вывод стримится, запись в Журнале; self-update на новую версию успешен; unit hardened (systemd-analyze security оценка приемлемая).

**Статус этапа 5 (31.08.2026, v0.5.0): ядро сделано.** Реализовано: Go-агент в `agent/` (cobra run/version; ed25519-энроллмент по HTTP с одноразовым токеном; WSS с challenge-response и backoff v5 cap 60с+jitter; gopsutil-метрики с дельтами bps/pps, conntrack null вне Linux; state.json 0600 с 32-байтным seed; systemd-юнит с закалкой; install.sh; Makefile build-all amd64+arm64+checksums; 11 unit-тестов). Панель: modules/agent (HTTP enroll + WS-шлюз на ws поверх того же HTTP-сервера, пиннинг ключа, конверт v1 из shared/agent-protocol.ts, метрики → VictoriaMetrics import, «переподключение вытесняет старое соединение»), install.sh-эндпоинт (обёртка над релизным установщиком), Настройки → «Автопроверки» (app_meta settings.autochecks: 4 тумблера+интервала, PUT с diff в Журнал, «По умолчанию» = PUT дефолтов), фоновые джобы: SSH-автопроверка (тик 60с, интервалы из настроек, в Журнал только смены статуса) и offline-детект (тик 10с, порог из настроек). CSRF не распространяется на /api/agent/*. Журнал: server.agent.enrolled/online/offline, server.autocheck.ssh, settings.autochecks.updated. Миграции 0008 (agent_pubkey/version/enrolled/last_seen) и 0009 (enrollment used_at). e2e: 62 (полный цикл агента, чужая подпись, одноразовость токена, настройки в welcome). ОТЛОЖЕНО на следующие подходы этапа: GitHub Releases+goreleaser CI (репозиторий агента ещё не создан пользователем), self-update, Xray gRPC StatsService, реестр команд (конверт готов), проверка на реальной VPS.

Доработки (31.08.2026, v0.5.1): Журнал — кнопка «Скопировать» в раскрытой записи (текстовый отчёт buildAuditReport: действие/кто/IP/браузер/когда/запрос/результат/цель/изменения/данные). Добавление сервера без проверки: verify:false в create (только «Свой ключ»/«Ключ панели»; с паролем — 400: пароль не хранится и нужен один раз для установки ключа), статус «SSH не проверен», проверит автопроверка; фронт шлёт verify:false когда не жали «Проверить подключение». Drag: перестановка слотов в onDragOver (модель Remnawave) — при отпускании призрак «долетает» в новый слот, артефакт «возврат на старое место + телепорт» устранён; onDragCancel не сохраняет порядок.\n\nДоработки (31.08.2026, v0.5.2): drop-анимация drag доведена — кэш списка пишется СИНХРОННО в onDragEnd до сброса dragOrder (onMutate у mutate — микротаск: на кадр возвращался старый порядок и «долёт» целился в прежний слот); кнопка «Скопировать» в Журнале — absolute на уровне первой строки деталей; репозиторий агента опубликован: github.com/feauche/nodeservice-agent (переименованы module path, install.sh, README, REPO панели), добавлен .github/workflows/release.yml (tag v* → vet+test → build-all → Release: бинари, checksums, install.sh, unit).\n\nДоработки (31.08.2026, v0.5.4): установка агента стала кнопкой — POST /servers/:id/agent/install (step-up): панель сама заходит по SSH и выполняет установочный скрипт; в диалоге «Установка агента» — primary «Установить по SSH» + ручная команда как запасной путь; installCommand качает install.sh НАПРЯМУЮ из GitHub-релизов (env AGENT_REPO, дефолт feauche/nodeservice-agent) — обёртка /api/agent/install.sh удалена; выпуск токена больше не переводит статус в pending («Ожидает агента» — только когда установка запущена или агент зарегистрировался); статусы агента — с заглавной; аудит server.agent.install (+failed).\n\n### Этап 6 — Страницы Overview и Servers (детальная)

**Оценка:** 5–6 дней

**Цель.** Дашборд по демо: KPI-плитки, sparklines, ring gauges, world map, список серверов с live-статусами; страница сервера с графиками, Xray-статистикой, действиями.

**Что появляется:**
- modules/metrics: агрегирующие endpoints (overview summary, per-server series с downsampling через PromQL range queries), SSE-стрим статусов серверов
- apps/web: route / (overview) — KpiTile, Sparkline, RingGauge, WorldMap (порт SVG из демо в components/primitives с data-props), ServerStatusList; route /servers/$id — вкладки Overview/Metrics/Xray/Actions/Journal (фильтр Журнала по target_id через search-params); действия (restart xray, reboot) через ConfirmDialog + step-up
- Recharts (shadcn chart) только для детальных графиков на странице сервера с выбором диапазона; sparklines на дашборде — собственный SVG
- Storybook stories для primitives (KpiTile, Sparkline, RingGauge, WorldMap)
- TanStack Query polling/SSE-инвалидация; i18n namespaces overview.json, servers.json

**Как делают профессионалы.** Remnawave frontend: React 19 + Vite + Zustand + TanStack Query + Recharts; shadcn chart на Recharts с интеграцией токенов тем. Beszel/Netdata: sparklines обновляются пушем.

**Что улучшаем (по research):**
- Демо-графику (sparkline/gauge/map) портировать как SVG 1:1, а не пересобирать на Recharts/Visx — библиотеки ломают пиксель-парность; Recharts только для аналитических графиков на странице сервера.
- Для плотных realtime-графиков (много серверов × секундные обновления) держать в резерве uPlot/ECharts canvas — Recharts рендерит каждую точку SVG-узлом.
- Все spring-анимации motion — за useReducedMotion().

**Чекпоинт (как проверяем):** Overview совпадает с демо во всех трёх темах (визуальный diff скриншотов); данные живые от реального агента; страница сервера показывает метрики за 1ч/24ч/7д и Xray-трафик по инбаундам; действия пишутся в Журнал; Storybook собирается.

**Статус этапа 6 (31.08.2026, v0.6.0): ядро сделано.** «Обзор» переверстан по демо 1:1 (первую версию «по мотивам» пользователь отклонил): полоса здоровья парка с легендой и %, 4 KPI-плитки (капс/крупное число/статус-точка/спарклайн в углу; «Соединений сейчас» по conntrack вместо «активных клиентов» — их даст Xray позже), панели «Требует внимания» (health-классификация: офлайн = SSH недоступен/агент не в сети; внимание = SSH не проверен/CPU>85/Mem>90/Disk>90; строки-ссылки на сервер) и «Трафик парка» (area-спарк, свой SVG), «Последние события» (вместо панели инцидентов демо — инциденты на этапе 8), нижняя полоса плиток. Детальная страница /servers/$serverId: шапка (пилюли, Проверить связь / Установить агента / Настройки), вкладки «Метрики» (Recharts area/line: CPU/Память/Диск/Сеть rx+tx/Load/Conntrack, диапазоны 1ч/24ч/7д, поллинг 15с на 1ч, пустые состояния) и «Журнал» (фильтр targetId — добавлен в shared/API). Клик по карточке серверов теперь ведёт на страницу (настройки — из меню «Изменить» и кнопкой на странице); диалог установки агента вынесен в agent-install-dialog. API modules/metrics: VmReaderService (PromQL query/query_range, VM недоступна → vmOk:false и пустые серии, не 500), overview (последние значения + cpuSpark по серверам + fleet-серии cpuAvg/traffic/conntrack за 15м) и series per-server (METRIC_RANGES 1h/30с, 24h/5м, 7d/30м). e2e metrics (запись в живую VM import + чтение через API; учтён search.latencyOffset VM ~30с — тест-точки старше минуты; skip если VM не поднята). Инструмент scripts/demo-shot.mjs — скрин эталона из design/preview.html для пиксельной сверки. ОТЛОЖЕНО: WorldMap и Storybook (роль визуальной проверки выполняют скриншот-скрипты), SSE-стрим статусов (поллинг 15с достаточен до этапа 8), sparkline у KPI «Серверов в норме» использует cpuAvg (истории онлайна нет), диалог «Доверять новому» при смене отпечатка на детальной (есть на карточке). Итог: api e2e 67, web 115, скрины m10-overview/m11-server-detail.

Доработки (31.08.2026, v0.6.1): детальная страница сервера заменена БОЛЬШОЙ модалкой (запрос пользователя): ?open=<id> в /servers, фиксированная высота (не прыгает между вкладками), навигация «Метрики / Журнал / Подключение» («Подключение» = бывшие настройки одним экраном, футер Удалить/SSH-терминал/Дублировать/Сохранить); шапка: имя+пилюли+адрес+ресурсы, справа «Проверить связь», меню ⋮ (Установить агента — только пока агент не в сети, Дублировать, Удалить) и свой крестик h-9 в одном ряду и стиле с кнопками (родной X отключён); маршрут servers_.$serverId и EditServerDialog удалены; пустые состояния графиков — центрированные с иконкой; %-карточки метрик получили тонкий прогресс-бар (приём Dokploy из research). БАГ-ФИКС по находке пользователя («345 conntrack»): сводка «Обзора» фильтрует ВСЕ запросы к VM по server_id живых серверов — иначе в суммы попадали серии e2e-тестов и удалённых серверов. Мок-метрики честные: только у серверов с агентом «в сети» (в сиде de-fra-01 online).\n\n### Этап 7 — Веб-терминал

**Оценка:** 4–5 дней

**Цель.** Перетаскиваемое/растягиваемое окно терминала (как в демо) с xterm.js, подключение к серверу через агент (PTY) или SSH-fallback, каждая сессия — в Журнал.

**Что появляется:**
- modules/terminal: ws gateway (/ws/terminal), аутентификация по сессии + step-up, режимы: agent-pty (команда terminal.open через агент, стрим байтов через тот же WSS с mux по session id) и ssh2 (host/port/credentials из инвентаря, ключи в зашифрованном хранилище), таймаут неактивности, лимит одновременных сессий, аудит terminal.open/close (без записи содержимого по умолчанию, опционально запись в файл с retention)
- agent/internal/commands terminal.open/resize/close с creack/pty
- apps/web: features/terminal — TerminalWindow на react-rnd (bounds, minWidth/minHeight, z-index через --z-terminal), @xterm/xterm 6 + addon-fit + addon-webgl (canvas fallback) + addon-clipboard, хук useTerminalSocket (backoff+jitter, singleton), кнопка из страницы сервера и из командной палитры (cmdk, Cmd+K)
- Playwright: открыть терминал, выполнить `echo ok`

**Как делают профессионалы.** Dokploy/Coolify: xterm.js + WebSocket ↔ ssh2/docker exec. Beszel: намеренно ограниченный SSH без pty — обратный ориентир: у нас PTY есть, но только через аутентифицированный и аудируемый канал.

**Что улучшаем (по research):**
- @xterm/xterm (v6), не deprecated пакет xterm; WebGL-аддон для быстрого вывода логов.
- Голый WebSocket-поток байт, без socket.io-фрейминга.
- Терминал через агента предпочтительнее хранения SSH-кредов в панели — меньше секретов в БД; SSH оставить как fallback для серверов без агента.

**Чекпоинт (как проверяем):** Из страницы сервера открывается окно, перетаскивается/ресайзится, `htop` рендерится корректно, resize пробрасывается; закрытие вкладки → сессия закрывается на сервере; в Журнале open/close с длительностью; без step-up терминал не открывается.

**Статус этапа 7 (01.09.2026, v0.7.0): веб-терминал сделан.** shared/terminal.ts (протокол: preflight POST /api/servers/:id/terminal за step-up → {url}; WS /ws/terminal?server=&cols=&rows=; сообщения {t:i|r} клиент, {t:y|o|x|e} сервер; лимиты idle 15м, max 4). API: infra/ws WsUpgradeService (единый server.on('upgrade')-роутер — агент и терминал регистрируют пути; agent.gateway.attach→register); SshService.openShell (PTY через ssh2 .shell, host key как в connect, StringDecoder для UTF-8 на границах чанков); modules/terminal (gateway с аутентификацией по session-cookie+свежий step-up, лимит сессий, idle-таймаут, аудит server.terminal.open/close без содержимого; controller preflight StepUpGuard). Фронт: features/terminal (zustand-стор одного окна, use-terminal-socket с withStepUp-preflight, TerminalWindow на react-rnd — хром 1:1 с демо #term: шапка-ручка «SSH · root@host:port», кнопки очистить/на весь экран/закрыть, xterm@6 FitAddon+WebLinks, тема из токенов, состояния Подключение/Сессия завершена; портал в body → над модалкой; Esc закрывает). Модалка сервера сделана modal={false} (иначе Radix гасит pointer-events терминала) + свой блюр-фон порталом + non-dismissable (крестик/Esc); кнопка «SSH-терминал» в «Подключении» открывает окно, модалка остаётся. vite proxy: добавлен '/ws' ws:true. FakeSsh получил pty/shell для e2e. e2e terminal (preflight 403→200 step-up, WS приветствие+эхо+аудит, без cookie→4401). Мок VITE_MOCK: Proxy над WebSocket отдаёт приглашение с UTF-8. Скрин m12-terminal. ОТЛОЖЕНО: agent-PTY (сейчас SSH-fallback; агент-команды — следующий подход), запись сессий в файл, cmdk-палитра. Итог: api e2e 73 (+terminal 3), web 120, скрины m12.

### Этап 8 — Инциденты, autofix, пресеты

**Оценка:** 5–6 дней

**Цель.** Правила детекции (agent offline, CPU/RAM/disk пороги, conntrack near max, Xray down, cert expiry), инциденты с жизненным циклом, пресеты autofix (реестр команд агента) с ручным подтверждением или автоматикой по политике, страница инцидентов.

**Что появляется:**
- Prisma: incidents (rule, server, severity, status open/acknowledged/resolved, started_at/resolved_at, autofix_attempts), incident_rules (zod-конфиг порогов), autofix_presets (последовательность команд из аллоулиста, условия, cooldown)
- modules/incidents: BullMQ repeatable job оценки правил по VictoriaMetrics + heartbeat-событиям, дедупликация/флаппинг (hysteresis, min duration), AutofixRunner (выполняет пресет через agent-gateway, ограничивает повторы, всё в Журнал), встроенные пресеты (restart xray, clear conntrack, rotate logs, free disk)
- apps/web: /incidents (список, фильтры, timeline инцидента с действиями autofix), /settings/incidents (правила и пресеты — формы rhf+zod), баннер активных инцидентов в overview
- Тесты: правила на синтетических сериях, autofix cooldown

**Как делают профессионалы.** Grafana/Prometheus alerting: for-duration и hysteresis против флаппинга; Netdata health alarms с настраиваемыми порогами; Coolify: ограниченный набор автоматических операций на серверах через чётко определённые команды.

**Что улучшаем (по research):**
- Autofix только из реестра команд агента (Stage 5) — никаких shell-скриптов из БД; каждая попытка с cooldown и cap, записывается в Журнал с результатом.

**Чекпоинт (как проверяем):** Остановка xray на тестовом сервере → инцидент через <1 мин → autofix 'restart xray' → resolved, вся цепочка в Журнале; симулированный флаппинг не плодит инциденты; правила редактируются в UI.

**Статус этапа 8 (01.09.2026, v0.8.0): инциденты сделаны.** shared/incidents.ts (виды agent_offline/ssh_down/cpu_high/mem_high/disk_high с INCIDENT_KIND_META, severity crit/warn/info, status open/acknowledged/resolved, timeline событий {at,by,action,result}; AUTOFIX_PRESETS restart_xray/restart_node/free_disk; incidentsSettingsSchema пороги+времяРеакции+автопочинка+кулдаун). API modules/incidents: репозиторий (частичный уник-индекс open по server_id+kind, onConflictDoNothing), сервис (детекция: agent_offline/ssh_down — мгновенно; cpu/mem/disk — с «временем реакции» через in-memory exceededSince, hysteresis; авто-resolve при исчезновении; автопочинка runAutofix — SSH-команда из встроенного реестра AUTOFIX_COMMANDS, кулдаун, таймлайн applied/failed), джоба @Interval 30с (метрики из VM {server_id=~live} → evaluate), контроллер (list/get/acknowledge/resolve/autofix за step-up). Настройки → «Инциденты» (пороги/время реакции/автопочинка/кулдаун, дефолт autofixEnabled=false). Фронт: /incidents (по демо — фильтр Все/Открытые/Решённые, карточки severity+статус, раскрытие с detail+таймлайном+автопочинкой, взять в работу/закрыть вручную, пустое состояние), баннер активных на Обзоре, пункт NAV с бейджем открытых. Миграция 0011. Аудит incident.opened/resolved/acknowledged/autofix, settings.incidents.updated. e2e incidents 4 (детекция agent_offline+авто-resolve, автопочинка по SSH+кулдаун, ручное закрытие, настройки). Джобы @Interval гвардятся NODE_ENV=test (детерминизм). ОТЛОЖЕНО (в этап 9): AI-подсказки/похожие инциденты, autofix через реестр команд агента (сейчас SSH-fallback), редактор пресетов. Итог: api e2e 74, web 129, скрины m13/m13b/m14.

### Этап 9 — AI-ассистент + база знаний

**Оценка:** 5–7 дней

**Цель.** Чат-ассистент внутри панели, знающий текущее состояние (серверы, инциденты, последние события Журнала) и базу знаний (runbooks, markdown-документы), с tool-calling только через read-only и аллоулист-действия с подтверждением.

**Что появляется:**
- Prisma: kb_documents (title, markdown, tags), kb_chunks (pgvector embedding), assistant_conversations/messages
- modules/assistant: провайдер LLM за абстракцией (Anthropic SDK через переменные окружения; ключ шифруется как TOTP-секрет), RAG (chunking, embeddings, pgvector cosine), tools: get_server_status, query_metrics (PromQL с ограничениями), search_audit, search_kb, propose_action (только создаёт предложение → пользователь подтверждает в UI → выполняется через реестр команд); стриминг ответа через SSE; лимиты токенов/бюджет; все вызовы tools и подтверждённые действия — в Журнал
- apps/web: /assistant (чат со стримингом, карточки предложений действий с Confirm+step-up), /knowledge (CRUD документов, markdown-редактор, импорт файлов), вход из командной палитры
- Тесты: RAG-ранжирование на фикстурах, tool-аллоулист (попытка неразрешённого действия отклоняется)

**Как делают профессионалы.** Паттерн agentic tools с human-in-the-loop: ассистент предлагает, оператор подтверждает (Vercel AI SDK / Anthropic tool use docs); pgvector как RAG-хранилище без внешнего векторного движка для self-hosted.

**Что улучшаем (по research):**
- Ассистент никогда не выполняет действия сам — только propose + подтверждение через тот же step-up/ConfirmDialog, что и ручные действия; это переиспользует реестр команд и Журнал.
- pgvector в том же Postgres вместо отдельного векторного сервиса — одна БД в бэкапах.

**Чекпоинт (как проверяем):** Вопрос «почему упал сервер X вчера» → ответ с цитатами из Журнала и метрик; предложение «перезапустить xray» появляется карточкой, выполняется только после подтверждения; LLM-ключ отсутствует → ассистент отключён с понятной подсказкой.

**Статус этапа 9 (01.09.2026, v0.9.0): AI-ассистент + база знаний сделаны.** База знаний: shared/knowledge.ts (KbDoc markdown+теги, kbDocCreate/Update, поиск), API modules/knowledge (репозиторий с ПОЛНОТЕКСТОВЫМ поиском — tsvector `search` GENERATED (setweight title A + content B) + gin-индекс, websearch_to_tsquery + ts_rank; НЕ pgvector — базовый postgres:18-alpine без расширения; RAG-lite по FTS через searchForContext), CRUD-контроллер, аудит kb.*. Ассистент: shared/assistant.ts (status enabled+model, chat request/response, AssistantMessage с citations+proposals, ASSISTANT_MODELS claude-*). API modules/assistant: LlmProvider за токеном LLM_PROVIDER (AnthropicProvider поверх @anthropic-ai/sdk; в тестах overrideProvider фейком), AssistantService — цикл tool-use (до 6 раундов): инструменты read-only (get_fleet_status/query_metrics/search_audit/search_kb) + propose_action (НЕ выполняет, только предложение — human-in-the-loop); citations из результатов инструментов, proposals из propose_action; беседы+сообщения в БД; без ключа → 409. Ключ LLM шифруется CryptoService, хранится в app_meta settings.assistant; AssistantSettingsStore вынесен в отдельный AssistantSettingsModule (иначе цикл Settings↔Assistant↔Incidents). Настройки → Ассистент (ключ/модель/убрать). Аудит assistant.chat, settings.assistant.updated. Миграция 0012 (kb_documents FTS, assistant_conversations/messages). Фронт: /assistant (демо #view-ai: левый рельс беседы, чат с markdown-рендером без зависимостей, цитаты-чипы, карточки-предложения с «Применить»→автопочинка через step-up, подсказки, индикатор набора; без ключа — блок «выключен» со ссылкой в настройки), /knowledge (демо #view-kb: поиск+список+редактор markdown, архив/удаление), вкладка настроек. e2e knowledge+assistant 4 (KB CRUD+FTS; ассистент выключен без ключа; чат с фейк-LLM: инструменты+citations+proposal; стирание ключа) — стабильно 3×. ОТЛОЖЕНО (осознанно): pgvector-эмбеддинги (FTS достаточно для соло-парка; апгрейд при росте базы), стриминг ответа SSE (сейчас полный ответ — стабильнее; полировка позже), выполнение действий ассистента через реестр команд агента (сейчас предложение→автопочинка по SSH). Итог: api e2e 78, web 138, скрины m15-knowledge/m16-assistant.

Доработки (01.09.2026, v0.9.1): ассистент отвязан от Anthropic — провайдер zveno.ai (OpenAI-совместимый шлюз https://api.zveno.ai/v1, ZvenoProvider маппит наш LlmBlock↔OpenAI chat.completions+tools, ключ Authorization Bearer, base URL из env ZVENO_BASE_URL). Настройки ассистента: провайдер выбором (пока только zveno.ai), НАЗВАНИЕ МОДЕЛИ и КЛЮЧ вводит администратор сам (свободный текст, формат vendor/model напр. anthropic/claude-sonnet-4-5); enabled = ключ И модель заданы. Контракт: ASSISTANT_PROVIDERS вместо ASSISTANT_MODELS, model — z.string(). LLM_PROVIDER→ZvenoProvider (AnthropicProvider оставлен для будущего). Плюс: все системные <select> заменены на свой компонент components/ui/select.tsx (Radix Select в стиле панели) — настройки ассистента (провайдер) и политика безопасности (idle/lock). Итог: api e2e 78, web 138.

### Этап 10 — Telegram-уведомления

**Оценка:** 2–3 дня

**Цель.** Отправка инцидентов, security-событий (новый логин, 2FA off), отчётов и результатов autofix в Telegram; настройка каналов и правил в UI.

**Что появляется:**
- modules/notifications: провайдер telegram (Bot API через fetch, без тяжёлых фреймворков; токен шифруется), очередь отправки BullMQ с retry/backoff и rate-limit (30 msg/s глобально, 1/s на чат), шаблоны сообщений (i18n ru), правила маршрутизации (severity → chat), тихие часы, daily digest (repeatable job), тестовая отправка
- Проверка chat_id через deep-link `/start <code>` (webhook или long-polling job)
- apps/web: /settings/notifications (каналы, правила, тест), индикатор доставки в timeline инцидента
- Аудит: notification.channel.create/update/delete, notification.sent (metadata: тип, chat)

**Как делают профессионалы.** Remnawave, Marzban, Dokploy: Telegram-уведомления через простой Bot API с шаблонами и выбором событий; Grafana contact points: маршрутизация по severity и mute timings.

**Улучшения:** очевидный подход здесь правильный — ничего не добавляем.

**Чекпоинт (как проверяем):** Инцидент из Stage 8 → сообщение в Telegram < 10 с с ссылкой на инцидент; digest приходит по расписанию; ошибка Bot API (неверный токен) видна в UI и Журнале, а не молча теряется.

### Этап 11 — Hardening и релиз

**Оценка:** 4–5 дней

**Цель.** Production-ready: security-заголовки/CSP, бэкапы/восстановление, обновления, документация, install.sh, публичные образы, релизный пайплайн.

**Что появляется:**
- CSP через helmet без unsafe-inline (hash для anti-FOUC inline-скрипта), HSTS, COOP/CORP; Caddy: HTTP/2, rate-limit на /api/auth, basicauth на служебные UI (bull-board, vmui) или только внутренняя сеть
- scripts/install.sh (Docker check, /opt/nodeservice, .env через openssl rand chmod 600, pinned compose по версии, pull/up, ожидание healthy 60 с, печать URL + setup-token), scripts/update.sh и команда `nodeservice update` (pg_dump → pull → prisma migrate deploy → up → health), scripts/backup.sh (pg_dump -Fc + restic S3/B2, keep-daily/weekly/monthly) + restore-инструкция и тест восстановления, Diun для уведомлений о новых образах
- release.yml: conventional commits → git-cliff CHANGELOG, tag → GHCR panel (multi-arch) + agent-бинари + install.sh как Release asset; образы публичные
- Renovate группировка minor/patch, automerge dev-deps
- docs/: install, upgrade, backup/restore, threat-model (в т.ч. панель и нода на разных хостах), protocol, ADR-ы; README
- Финальный прогон: Playwright E2E против compose-стека, testcontainers-интеграция, `docker scout`/trivy скан образов, systemd-analyze security для агента

**Как делают профессионалы.** Coolify install.sh/upgrade.sh: генерация секретов, ожидание healthy, бэкап перед апгрейдом; Remnawave-scripts: /opt/<app> с бэкап-директорией; Dokploy: install.sh как Release asset; remnawave/frontend: conventional-changelog вместо Changesets; GHCR через docker/build-push-action с cache gha.

**Что улучшаем (по research):**
- Не Watchtower (archived 12/2025) — явный `nodeservice update` с pg_dump перед миграцией; Diun только уведомляет.
- Nonce-CSP не подходит статической SPA за Caddy — hash-based CSP для единственного inline-скрипта темы, остальное без inline.
- Conventional commits + git-cliff, а не Changesets — одна версия приложения = Docker-тег.
- Документировать как ограничение: не размещать панель на том же хосте, что VPN-нода; внутренние сервисы без ports:, VictoriaMetrics без auth только во внутренней сети.

**Чекпоинт (как проверяем):** На чистой VPS `curl -fsSL …/install.sh | bash` → панель доступна по HTTPS с валидным сертификатом за ~2 мин; `nodeservice update` с v0.1.0 на v0.2.0 проходит с бэкапом; restore из restic на чистом стеке восстанавливает данные; сканы образов без critical CVE; CHANGELOG и Release созданы автоматически по тегу.

## 3. Версии (август 2026, проверить `npm view` перед пином)

- Node.js 24.x LTS (engines >=24.4.0)
- pnpm 10.22.x (packageManager)
- TypeScript ~5.9.x
- @biomejs/biome 2.5.x (pinned -E)
- lefthook 1.x
- NestJS @nestjs/core 11.2.x, @nestjs/config 4.0.x, @nestjs/swagger 11.4.x, @nestjs/terminus 11.1.x, @nestjs/bullmq 11.0.x, @nestjs/cqrs 11.x, @nestjs/event-emitter 3.x
- @scalar/nestjs-api-reference 1.2.x
- zod 4.4.x, nestjs-zod 5.5.x
- Prisma / @prisma/client 6.19.x, kysely 0.28.x, prisma-kysely
- PostgreSQL 18.6 (postgres:18.6-alpine), pg_partman 5.4.x, pgvector 0.8.x
- Valkey 8.x (valkey/valkey:8-alpine)
- bullmq 6.3.x, ioredis 5.11.x, @bull-board/nestjs 9.x
- nestjs-pino 4.x + pino 9.x, nestjs-cls 5.x
- argon2 0.45.x, otplib 13.5.x, qrcode 1.5.x, rate-limiter-flexible 11.2.x, csrf-csrf 4.0.x, helmet 8.3.x, nest-commander 3.20.x, @simplewebauthn/server 13.3.x (позже)
- ws 8.x, ssh2 1.16.x, @nestjs/platform-ws 11.x
- Orval 8.x
- Vitest 4.0.x, @testing-library/react 16.x, msw 2.x, @testcontainers/postgresql 11.x, Playwright 1.5x (latest), Storybook 9.x
- react 19.2.x, react-dom 19.2.x, vite 7.x, @vitejs/plugin-react 5.x, vite-tsconfig-paths 5.x
- @tanstack/react-router 1.1xx + @tanstack/router-plugin, @tanstack/react-query 5.102.x, @tanstack/react-table 8.x, @tanstack/react-virtual 3.x
- zustand 5.0.x, react-hook-form 7.8x, @hookform/resolvers 5.x
- tailwindcss 4.3.x, @tailwindcss/vite 4.3.x, shadcn CLI 4.x (-b radix), radix-ui (unified) 1.x, tw-animate-css 1.x, sonner 2.x, cmdk 1.x, react-rnd 10.5.x, next-themes 0.4.x, motion 12.x, lucide-react (latest)
- @fontsource-variable/archivo, @fontsource-variable/ibm-plex-sans, @fontsource/ibm-plex-mono (latest)
- recharts 3.9.x (только страница сервера), uPlot — резерв
- @xterm/xterm 6.0.x, @xterm/addon-fit, @xterm/addon-webgl, @xterm/addon-clipboard
- i18next 26.x, react-i18next 17.x
- Go 1.25.x; github.com/coder/websocket 1.8.x; github.com/spf13/cobra 1.10.x; github.com/shirou/gopsutil/v4 4.26.x; github.com/cenkalti/backoff/v5 (v5 latest tagged; v7 если опубликован) — проверить go list; github.com/rs/zerolog 1.34.x; github.com/creack/pty 1.1.x; google.golang.org/grpc 1.7x; goreleaser 2.x
- Caddy 2.11.x, VictoriaMetrics single-node v1.146.0, Docker Compose 5.x (проверить `docker compose version`), restic 0.18.x, Diun 4.x
- GitHub Actions: actions/checkout@v5, actions/setup-node@v5, pnpm/action-setup@v5, biomejs/setup-biome@v2, autofix-ci/action, docker/build-push-action@v6, docker/metadata-action@v5, docker/login-action@v3, actions/setup-go@v5, golangci/golangci-lint-action@v8, git-cliff

## 4. Риски

- NestJS 12 (27.08.2026) и Vite 8 — свежие мажоры: старт на 11.2.x/7.x осознанный, но пакеты экосистемы (nestjs-zod, @nestjs/bullmq, throttler) могут начать требовать 12; закладывать миграцию в бэклог после Stage 11.
- Версии в этом плане — с точностью до минора на 08/2026 по результатам исследования; часть (cenkalti/backoff v7, pnpm 10 vs 11, Compose 5.x, @tanstack/react-router) требует проверки `npm view`/`go list` перед пином — особенно Go-модули.
- shadcn/ui переход на Base UI: без флага -b radix и `shadcn migrate radix` возможна смесь API; обновления CLI могут менять генерируемые компоненты — components/ui не править руками.
- Нативные биндинги (argon2, ssh2 cpu-features, Prisma engines) на arm64/alpine — использовать node:24-slim и тестировать multi-arch сборку в CI с первого релиза; @node-rs/argon2 как запасной вариант.
- Audit hash-chain не защищает от самого администратора/суперпользователя БД — не заявлять tamper-proof без внешнего якоря; риск ложного чувства безопасности.
- pg_partman/pg_cron требуют расширений в образе postgres — официальный postgres:18-alpine их не содержит; нужен собственный образ или создание партиций из BullMQ-джоба панели (fallback-план).
- Ротация ключа шифрования TOTP/LLM/Telegram-секретов без re-encrypt ломает 2FA (Dokploy #3645) — версионирование ключей и CLI-команда re-encrypt обязательны до релиза.
- Реестр команд агента и версия протокола — самые дорогие для позднего изменения решения; ошибки в Stage 5 тянут переделку Stage 7–9.
- SSE за Caddy/HTTP-1.1 и множество вкладок — лимит 6 соединений; убедиться, что Caddy отдаёт HTTP/2 и не буферизует text/event-stream.
- ioredis в maintenance-режиме: BullMQ может со временем сделать node-redis основным клиентом — держать Redis-клиент за одним провайдером в infra/valkey для замены.
- Совмещение панели и ноды на одном хосте (соблазн для соло-лаборатории) ломает границу доверия исходящего WSS; документировать и предупреждать в install.sh.
- Объём: 12 стадий ≈ 50–65 рабочих дней для одного разработчика; риск растягивания на этапах 5 и 9 (агент и AI) — держать MVP-скоуп реестра команд и tools минимальным.
- Самообновление агента и `nodeservice update` — единственные точки массового поломки флота; обязательный canary (обновить один сервер) и откат к предыдущему бинарю по подписи.

## 5. Порядок работы прямо сейчас

1. ✅ Этап 0 — сделан 2026-08-29: монорепо (pnpm 11 + Turborepo + Biome + lefthook + CI), `apps/web` (Vite 8 + React 19, три темы, шрифты Golos/Plex, TanStack Router/Query, shadcn Radix, Vitest), `apps/api` (NestJS 11.2, zod-env, pino + request-id, problem+json, Drizzle + миграции при старте, Valkey, terminus health, OpenAPI + Scalar, Dockerfile node:24-slim), `packages/shared`, `infra/compose.yaml` (prod) + `compose.dev.yaml` + Caddyfile. Чекпоинт пройден против живого dev-стека.
2. ✅ Этап 1 — сделан 2026-08-29: backend auth (argon2id+pepper, AES-GCM, сессии Valkey, CSRF, throttling, TOTP anti-replay, коды восстановления, доверенные устройства, setup-токен, Rescue CLI; 32 unit + 20 e2e), страницы /setup (3 шага), /login, /login/2fa, /login/recovery, /lock, каркас приложения после входа; 47 тестов web; скрипт `scripts/screenshots.mjs` снимает все экраны в трёх темах против живого API. Скриншоты — `docs/screenshots/`.
3. Этап 2 — Журнал: всё пишется в журнал, страница с фильтрами и live-лентой → показать и проверить.
4. Дальше по этапам 3 → 11, каждый — со своим чекпоинтом. Доработка дизайна экранов — уже в продукте, постранично.