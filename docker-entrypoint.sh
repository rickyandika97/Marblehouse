#!/bin/sh
# Runs on every container start, before the app serves traffic.
#
# NOTE: `migrate deploy` only APPLIES migrations that are already committed in
# prisma/migrations. It never generates one. Migrations are created on your Mac
# with `npm run db:migrate` and committed to git. This is what stops the dev and
# production schemas drifting apart.
set -e

echo "==> Waiting for Postgres..."
until pg_isready -h "${POSTGRES_HOST:-postgres}" -p "${POSTGRES_PORT:-5432}" -q; do
  sleep 1
done
echo "==> Postgres is ready."

echo "==> Applying database migrations..."
npx prisma migrate deploy

echo "==> Seeding (idempotent — safe to run on every boot)..."
npx tsx prisma/seed.ts

echo "==> Starting app on port ${PORT:-5050}"
exec "$@"
