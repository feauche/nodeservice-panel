# syntax=docker/dockerfile:1.7
# Сборка из корня монорепо: docker build -f apps/api/Dockerfile .
# node:24-slim (Debian), не alpine — нативные модули (argon2, pg) на musl ломаются.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN npm i -g pnpm@11 && apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# Хэш коммита и дата сборки попадают в подсказку у версии панели (в контексте сборки нет .git).
ARG APP_COMMIT=dev
ARG APP_BUILT_AT=
ENV APP_COMMIT=$APP_COMMIT APP_BUILT_AT=$APP_BUILT_AT
# Сначала общий пакет: web и api импортируют его из dist (в git и в контекст сборки dist не попадает).
RUN pnpm --filter @nodeservice/shared build && pnpm --filter web build && pnpm --filter api build \
 && pnpm --filter api deploy --legacy --prod /out/api \
 && cp -r apps/api/dist /out/api/dist \
 && cp -r apps/api/drizzle /out/api/drizzle \
 && mkdir -p /out/api/public && cp -r apps/web/dist/. /out/api/public/

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3000
# Резервные копии из панели: pg_dump/pg_restore той же версии, что Postgres в стеке (18, из репозитория PGDG).
# ns-tar / ns-du — копии tar и du с единственным правом «читать любой файл» (cap_dac_read_search): ими
# панель упаковывает «Дополнительные файлы и папки» сервера (/ смонтирован только на чтение). Право
# действует, только если compose выдал его контейнеру (cap_add: DAC_READ_SEARCH).
# uid 10001 — постоянный: папку backups на сервере install.sh/update.sh отдают этому пользователю.
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates curl gnupg libcap2-bin \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.gpg \
 && . /etc/os-release \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.gpg] https://apt.postgresql.org/pub/repos/apt $VERSION_CODENAME-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update && apt-get install -y --no-install-recommends postgresql-client-18 \
 && cp "$(command -v tar)" /usr/local/bin/ns-tar && cp "$(command -v du)" /usr/local/bin/ns-du \
 && setcap cap_dac_read_search+ep /usr/local/bin/ns-tar && setcap cap_dac_read_search+ep /usr/local/bin/ns-du \
 && apt-get purge -y curl gnupg libcap2-bin && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* \
 && groupadd -r -g 10001 nodeservice && useradd -r -u 10001 -g nodeservice -d /app nodeservice \
 && mkdir -p /app/backups && chown nodeservice:nodeservice /app/backups && chmod 700 /app/backups
WORKDIR /app
COPY --from=build --chown=nodeservice:nodeservice /out/api .
USER nodeservice
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
