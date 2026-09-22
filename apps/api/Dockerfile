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
# Сначала общий пакет: web и api импортируют его из dist (в git и в контекст сборки dist не попадает).
RUN pnpm --filter @nodeservice/shared build && pnpm --filter web build && pnpm --filter api build \
 && pnpm --filter api deploy --legacy --prod /out/api \
 && cp -r apps/api/dist /out/api/dist \
 && cp -r apps/api/drizzle /out/api/drizzle \
 && mkdir -p /out/api/public && cp -r apps/web/dist/. /out/api/public/

FROM node:24-slim AS runtime
ENV NODE_ENV=production PORT=3000
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/* \
 && groupadd -r nodeservice && useradd -r -g nodeservice -d /app nodeservice
WORKDIR /app
COPY --from=build --chown=nodeservice:nodeservice /out/api .
USER nodeservice
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
