# NodeService — web

Фронт панели: React 19 + Vite, TanStack Router (file-based) + TanStack Query, Tailwind v4 + shadcn/ui, zustand.

## Запуск

```sh
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$PATH"
pnpm dev                       # http://localhost:5173, /api проксируется на localhost:3000
VITE_MOCK=1 pnpm dev           # без бэкенда: MSW отвечает за /api (admin / «correct horse battery» / 2FA 123456)
VITE_MOCK=1 VITE_MOCK_SETUP=1 pnpm dev   # мок стартует с мастера первого запуска (токен setup-token-123456)
```

Проверки: `pnpm typecheck`, `pnpm lint` (Biome), `pnpm test` (Vitest + Testing Library + MSW), `pnpm build`.
Роуты генерируются автоматически (`pnpm gen:routes`), `src/routeTree.gen.ts` руками не править.

## Структура

```
src/
  lib/api.ts              fetch-обёртка: /api, cookie, CSRF (x-csrf-token), problem+json → ApiError, zod-парсинг
  lib/query-client.ts     TanStack Query
  features/auth/
    api.ts                типизированные вызовы /api/auth по контракту @nodeservice/shared
    store.ts              zustand: me, setupRequired, locked (sessionStorage), pendingTotp
    queries.ts            хуки Query/Mutation, hydrateAuth() для роутера
    guards.ts             requireAuth / requireGuest / requireSetup / requireLocked / requirePendingTotp
    components/           AuthShell, PasswordField, PasswordMeter, OtpField, ErrorBox, InfoBox, Steps, Field, CtaButton, LogoutDialog
    pages/                login, 2fa, recovery, setup (3 шага), lock
  features/settings/      настройки: appearance (тема), security (вход, эта сессия), общие карточки/строки/пилюли
  features/theme/         три темы (data-ns-theme), useTheme()
  components/layout/      AppShell — рейл 250px, топбар 62px, меню пользователя
  components/theme-menu   ThemeMenu + Swatch — выпадающий список тем (шапка панели и экраны входа)
  components/confirm-dialog  ConfirmDialog (kind default/warn/crit, «Да, …» / «Нет») + useConfirm()
  components/ui/          shadcn/ui — не редактировать руками
  routes/                 файловые маршруты; контекст роутера — { queryClient }
                          /settings — layout с вкладками, /settings/appearance, /settings/security (индекс редиректит)
  test/msw/               моковые обработчики /api/auth (тесты и VITE_MOCK=1)
```

Статус сессии загружается один раз в `beforeLoad` через `queryClient.ensureQueryData` и кладётся в стор;
guards читают кэш, лишних запросов при переходах нет.
