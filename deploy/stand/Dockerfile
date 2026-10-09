# syntax=docker/dockerfile:1
# Образы стенда из монорепозитория. Контекст сборки — корень репозитория.
#   target app — сервис контекста, push-шлюз и песочница РИС/ЛИС (TypeScript через tsx);
#   target web — Caddy со статическим веб-клиентом.

# BUILD_CA_FILE (секрет сборки build_ca) — корневой сертификат корпоративного прокси, если сеть подменяет TLS.
# В образ он не попадает.
FROM node:22-slim AS base
ENV CI=true PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 COREPACK_HOME=/opt/corepack
RUN --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    corepack enable && corepack prepare pnpm@10.28.0 --activate && chmod -R a+rX /opt/corepack
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/ccs/package.json apps/ccs/
COPY apps/host-mock/package.json apps/host-mock/
COPY apps/push-gateway/package.json apps/push-gateway/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
COPY packages/tokens/package.json packages/tokens/
RUN --mount=type=secret,id=build_ca \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --frozen-lockfile

FROM deps AS source
COPY tsconfig.base.json ./
COPY design design
COPY packages packages
COPY apps apps

FROM source AS web-build
RUN pnpm --filter @konsilium/web run build:static

FROM source AS app
USER node
CMD ["node", "--import", "tsx", "apps/ccs/src/index.ts"]

FROM caddy:2.10-alpine AS web
COPY --from=web-build /app/apps/web/dist /srv
COPY deploy/stand/caddy /etc/caddy
