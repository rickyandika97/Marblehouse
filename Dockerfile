# syntax=docker/dockerfile:1
#
# Debian slim, not Alpine. Prisma, argon2 and (later) sharp all ship glibc
# prebuilt binaries; Alpine's musl is where native-module pain comes from.
# This image builds identically on your Mac (arm64) and the Windows box (amd64)
# because each host builds it from source — never push the built image between them.

# ---------- deps: production dependencies only ----------
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ---------- builder: full deps, generate client, build Next ----------
FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---------- runner ----------
FROM node:22-bookworm-slim AS runner
WORKDIR /app

# postgresql-client-16 SPECIFICALLY, from PGDG — not Debian's default.
#
# Bookworm ships postgresql-client 15, and `pg_dump` REFUSES to dump a server
# newer than itself:
#
#   pg_dump: error: aborting because of server version mismatch
#   detail: server version: 16.13; pg_dump version: 15.18
#
# docker-compose.yml runs postgres:16-alpine, so with the default package every
# nightly backup would fail — in production only. Dev on this Mac uses
# Homebrew's pg_dump 16 and works perfectly, so nothing else in the phase gates
# catches it: typecheck, lint, tests and even `docker compose build` all pass.
# Found by running pg_dump inside the built image against a v16 server.
#
# `restore.sh` needs the matching pg_restore for the same reason.
RUN apt-get update && apt-get install -y --no-install-recommends \
      openssl ca-certificates tini curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
         -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
         > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && apt-get purge -y gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=5050

COPY --from=deps    /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
# `src`, `scripts` and `tsconfig.json` are not needed to serve `next start`,
# but two things in this image are `tsx` run over the same TypeScript source
# the app imports (resolving the "@/*" alias through tsconfig.json), and both
# fail with module-not-found without them:
#   - `prisma/seed.ts`, which docker-entrypoint.sh runs on EVERY container
#     start. Missing these crash-loops the container — it builds clean and
#     dies on boot, which `docker compose build` cannot catch (D-159).
#   - on-demand backup/restore tooling (`npm run backup`, run via
#     `docker compose exec`).
COPY --from=builder /app/src ./src
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY package.json next.config.ts ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Runtime data lives on bind mounts so you can see it from Finder/Explorer.
RUN mkdir -p /data /backups && chown -R node:node /data /backups /app
USER node

EXPOSE 5050
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "run", "start"]
