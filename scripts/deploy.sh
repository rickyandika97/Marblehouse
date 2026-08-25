#!/usr/bin/env bash
#
# Marblehouse day-2 deploy. Run on the production machine from the repo root:
#
#   ./scripts/deploy.sh
#
# What "deploy" means here: unlike BisMan (bare metal + PM2), this app is
# Docker Compose only (CLAUDE.md — "Nothing may depend on Vercel... this is
# self-hosted"), and `docker-entrypoint.sh` already runs `prisma migrate
# deploy` and reseeds on every container boot. So there is no separate
# install/build/migrate/restart sequence to hand-order here — `docker compose
# up -d --build` IS that sequence, done correctly, every time. What this
# script adds on top:
#
#   1. Refuse to run over uncommitted local changes.
#   2. Take a backup of the CURRENTLY RUNNING app before touching anything —
#      via `docker compose exec`, so DATABASE_URL resolves inside the Docker
#      network exactly like the 02:00 cron backup does (see
#      src/server/jobs/scheduler.ts). A pull that turns out to be wrong is
#      routine; losing the ability to go back to before it is not.
#   3. Pull, rebuild, recreate — preserving the tunnel profile if it was
#      running, so a plain re-run doesn't silently drop cloudflared.
#   4. Poll /api/health until the new container reports ok, rather than
#      declaring victory the moment `docker compose up` returns.
#
# Migrations are never created here — only applied, by the entrypoint, same
# as every other boot. Never run `db:migrate` on this machine (README, "Ongoing
# updates").

set -euo pipefail
cd "$(dirname "$0")/.."

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; NC=$'\033[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$GRN" "$NC" "$*"; }
ok()   { printf '%s✔%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$NC" "$*"; }
die()  { printf '%s✘ %s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }

command -v docker >/dev/null || die "docker not found."
docker compose version >/dev/null 2>&1 || die "docker compose (v2) not found."
command -v curl >/dev/null || die "curl not found (needed for the post-deploy health check)."
[ -f .env ] || die ".env not found. Copy .env.example and fill in production secrets first."

# ── 1. Refuse a deploy over in-progress local work ──────────────────────────
# This machine should only ever be a `git pull` target — never a place code is
# authored. Uncommitted changes here are either a mistake or something that
# would be silently discarded/conflicted by the pull below.
if [ -n "$(git status --porcelain)" ]; then
  die "Working tree is not clean. Commit, stash, or discard local changes before deploying:
$(git status --short)"
fi

# ── 2. Was the tunnel profile running? Keep it that way. ────────────────────
TUNNEL_ARGS=()
if docker compose ps --status running --services 2>/dev/null | grep -qx cloudflared; then
  TUNNEL_ARGS=(--profile tunnel)
  say "cloudflared is running — will keep the tunnel profile active."
fi

APP_WAS_RUNNING=0
if docker compose ps --status running --services 2>/dev/null | grep -qx app; then
  APP_WAS_RUNNING=1
fi

# ── 3. Pre-deploy backup of the CURRENT app, before anything changes ────────
if [ "$APP_WAS_RUNNING" -eq 1 ]; then
  step "Pre-deploy backup"
  if docker compose exec -T app npm run backup; then
    ok "Backup complete."
  else
    die "Backup failed — refusing to deploy on top of an unbacked-up database. Investigate before retrying."
  fi
else
  warn "App container is not running (first deploy?) — skipping pre-deploy backup."
fi

# ── 4. Pull ───────────────────────────────────────────────────────────────
step "git pull"
git pull --ff-only

# ── 5. Rebuild and recreate. Migrations + seed run inside the entrypoint. ──
step "docker compose up -d --build"
docker compose "${TUNNEL_ARGS[@]}" up -d --build

# ── 6. Wait for the new container to actually be healthy ───────────────────
step "Waiting for /api/health"
PORT="$(grep -E '^PORT=' .env | cut -d= -f2- || true)"
PORT="${PORT:-5050}"
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
    HEALTHY=1
    break
  fi
  sleep 2
done

if [ "$HEALTHY" -eq 1 ]; then
  ok "App is healthy on port ${PORT}."
else
  docker compose logs --tail=50 app
  die "App did not report healthy after 60s. Logs above — check before assuming this deploy is good."
fi

step "done"
docker compose ps
