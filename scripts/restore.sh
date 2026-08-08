#!/usr/bin/env bash
#
# Restore a Marblehouse backup (PRD §13.3).
#
#   ./scripts/restore.sh backups/marblehouse-2026-08-03-0200.tar.gz [--force]
#
# ─────────────────────────────────────────────────────────────────────────────
# The rule this script exists to enforce
# ─────────────────────────────────────────────────────────────────────────────
#
# §13.3: "A restore that silently loses 5% of rows is worse than a restore that
# fails." So this script ALWAYS prints a per-table diff of the manifest's row
# counts against what actually landed, and exits non-zero if they disagree.
# A restore you have to read carefully is not a restore you can trust at 2am.
#
# It also refuses to touch a non-empty database unless --force is passed. The
# machine you are restoring onto is usually a fresh one, and the time you are
# most likely to run this by accident is when you are panicking.
#
# This is deliberately POSIX shell + psql/pg_restore rather than a Node script:
# it has to work on a machine where the app does not boot, which is the whole
# scenario. It needs pg_restore, psql, tar and sha256sum (or shasum on macOS).
#
# NOTE: backups are NOT encrypted — owner decision, 8 Aug 2026 (§13.5,
# BUILD-LOG D-71). If that ever changes, decryption goes here, before the
# checksum check.

set -euo pipefail

ARCHIVE="${1:-}"
FORCE="${2:-}"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YEL=$'\033[0;33m'; NC=$'\033[0m'
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s✔%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '%s!%s %s\n' "$YEL" "$NC" "$*"; }
die()  { printf '%s✘ %s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }

[ -n "$ARCHIVE" ] || die "Usage: $0 <backup.tar.gz> [--force]"
[ -f "$ARCHIVE" ] || die "No such archive: $ARCHIVE"
[ -n "${DATABASE_URL:-}" ] || die "DATABASE_URL is not set. Source your .env first."

command -v pg_restore >/dev/null || die "pg_restore not found (install postgresql-client)."
command -v psql       >/dev/null || die "psql not found (install postgresql-client)."

# sha256sum on Linux, shasum -a 256 on macOS.
if command -v sha256sum >/dev/null; then
  SHA_CHECK() { sha256sum -c "$1"; }
elif command -v shasum >/dev/null; then
  SHA_CHECK() { shasum -a 256 -c "$1"; }
else
  die "Neither sha256sum nor shasum found."
fi

ARCHIVE_DIR=$(cd "$(dirname "$ARCHIVE")" && pwd)
ARCHIVE_FILE=$(basename "$ARCHIVE")
ARCHIVE_PATH="$ARCHIVE_DIR/$ARCHIVE_FILE"

DATA_DIR="${DATA_DIR:-./data}"

say "─────────────────────────────────────────────────────────────"
say " Marblehouse restore"
say "─────────────────────────────────────────────────────────────"
say " Archive : $ARCHIVE_FILE"
say " Target  : ${DATABASE_URL%%\?*}"
say " Data dir: $DATA_DIR"
say ""

# ── 1. Verify the archive BEFORE touching anything ───────────────────────────
# Checksum first: restoring a truncated dump over a live database would be the
# worst possible outcome of running this script.
if [ -f "$ARCHIVE_PATH.sha256" ]; then
  ( cd "$ARCHIVE_DIR" && SHA_CHECK "$ARCHIVE_FILE.sha256" >/dev/null ) \
    || die "Checksum FAILED. This archive is corrupt — do not restore it."
  ok "Archive checksum verified"
else
  warn "No .sha256 sidecar found — cannot verify archive integrity."
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

tar -xzf "$ARCHIVE_PATH" -C "$WORK" || die "Could not unpack the archive."
[ -f "$WORK/manifest.json" ]  || die "Archive has no manifest.json — not a Marblehouse backup."
[ -f "$WORK/database.dump" ]  || die "Archive has no database.dump."
ok "Archive unpacked"

# Verify the inner files against the manifest's own hashes.
for f in database.dump data.tar.gz; do
  [ -f "$WORK/$f" ] || continue
  want=$(node -e "
    const m=require('$WORK/manifest.json');
    const e=(m.files||[]).find(x=>x.name==='$f');
    process.stdout.write(e?e.sha256:'');
  " 2>/dev/null || true)
  [ -n "$want" ] || continue
  if command -v sha256sum >/dev/null; then got=$(sha256sum "$WORK/$f" | cut -d' ' -f1)
  else got=$(shasum -a 256 "$WORK/$f" | cut -d' ' -f1); fi
  [ "$want" = "$got" ] || die "$f does not match the manifest checksum. Archive is corrupt."
done
ok "Inner file checksums match the manifest"

MANIFEST_CREATED=$(node -e "process.stdout.write(require('$WORK/manifest.json').createdAt||'?')")
MANIFEST_MIGRATION=$(node -e "process.stdout.write(String(require('$WORK/manifest.json').schemaMigration||'?'))")
MANIFEST_ROWS=$(node -e "process.stdout.write(String(require('$WORK/manifest.json').totalRows||0))")
say ""
say " Backup taken     : $MANIFEST_CREATED"
say " Schema migration : $MANIFEST_MIGRATION"
say " Rows in manifest : $MANIFEST_ROWS"
say ""

# ── 2. Refuse a non-empty database unless --force ────────────────────────────
EXISTING=$(psql "$DATABASE_URL" -tAc \
  "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" \
  2>/dev/null || echo "unreachable")

[ "$EXISTING" != "unreachable" ] || die "Cannot connect to the database. Is Postgres up?"

if [ "$EXISTING" -gt 0 ]; then
  if [ "$FORCE" != "--force" ]; then
    say "${RED}The target database already contains $EXISTING table(s).${NC}"
    say ""
    say "Restoring would DROP AND REPLACE all of it. If that is genuinely what"
    say "you want — for example a rehearsal on a scratch database — re-run with:"
    say ""
    say "    $0 $ARCHIVE --force"
    say ""
    die "Refusing to overwrite a non-empty database without --force."
  fi
  warn "Database is not empty and --force was given — existing data will be replaced."
fi

# ── 3. Restore ───────────────────────────────────────────────────────────────
say ""
say "Restoring database …"
# --clean --if-exists so a --force run over an existing schema replaces it
# rather than colliding. Exit status is checked loosely: pg_restore warns about
# things like missing roles that do not mean the data failed to load, so the
# row-count diff below is the real verdict, not this exit code.
set +e
pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname "$DATABASE_URL" "$WORK/database.dump" 2> "$WORK/restore.log"
RESTORE_STATUS=$?
set -e

if [ $RESTORE_STATUS -ne 0 ]; then
  warn "pg_restore exited $RESTORE_STATUS — see warnings below. Verifying row counts anyway."
  tail -20 "$WORK/restore.log" || true
fi
ok "Database loaded"

# ── 4. Restore the data directory (photos, receipts) ─────────────────────────
if [ -f "$WORK/data.tar.gz" ]; then
  mkdir -p "$DATA_DIR"
  tar -xzf "$WORK/data.tar.gz" -C "$DATA_DIR"
  FILE_COUNT=$(find "$DATA_DIR" -type f | wc -l | tr -d ' ')
  ok "Data directory restored ($FILE_COUNT files under $DATA_DIR)"
else
  warn "Archive contained no data.tar.gz — no photos or receipts restored."
fi

# ── 5. The row-count diff — the point of the whole script ────────────────────
say ""
say "─────────────────────────────────────────────────────────────"
say " Row counts: manifest vs restored"
say "─────────────────────────────────────────────────────────────"

MISMATCHES=0
while IFS='|' read -r table want; do
  [ -n "$table" ] || continue
  got=$(psql "$DATABASE_URL" -tAc "SELECT COUNT(*) FROM \"$table\";" 2>/dev/null || echo "MISSING")
  if [ "$got" = "$want" ]; then
    printf '  %-24s %8s  %s✔%s\n' "$table" "$got" "$GRN" "$NC"
  else
    printf '  %-24s %8s  %s✘ expected %s%s\n' "$table" "$got" "$RED" "$want" "$NC"
    MISMATCHES=$((MISMATCHES + 1))
  fi
done < <(node -e "
  const m = require('$WORK/manifest.json');
  for (const t of m.tableCounts || []) console.log(t.table + '|' + t.rows);
")

say ""
if [ "$MISMATCHES" -gt 0 ]; then
  die "$MISMATCHES table(s) do NOT match the manifest. This restore is INCOMPLETE — do not go live on it."
fi

ok "Every table matches the manifest exactly."
say ""
say "Next steps (§13.3):"
say "  1. docker compose up -d"
say "  2. Log in as owner and check yesterday's sales total."
say "  3. Open a customer with a known balance."
say "  4. View an attendance photo."
say ""
