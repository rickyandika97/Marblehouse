#!/bin/bash
# Phase 9 acceptance: backup, restore and hardening (PRD §11, §13, §16).
#
# Needs the dev server on localhost:5050 and the Phase 8 test accounts.
#
# §16 accepts Phase 9 on:
#
#   "a full restore onto a clean machine reproduces the system exactly,
#    verified against the manifest — and you have personally rehearsed it
#    once, start to finish."
#
# **The second half is the OWNER's, and this script cannot close it.** What it
# does prove is the first half mechanically: it takes a real backup, restores
# it into a scratch database, and compares every table against the manifest.
# The rehearsal on a second physical machine remains outstanding — see the
# BUILD-LOG.
#
# This script WRITES: it creates backup archives in backups/ and creates and
# drops a scratch database named marblehouse_verify9. It never touches
# marblehouse_dev's data.
set -u
cd "$(dirname "$0")/.." || exit 1

B=http://localhost:5050
D=$(mktemp -d)
O=$D/owner.txt; M=$D/mgr.txt; S=$D/staff.txt
FAILED=0
SCRATCH_DB=marblehouse_verify9

j() { curl -sS "$@"; }
c() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }

# D-43: an empty actual almost always means the command errored rather than
# genuinely returning "". A check that passes because it crashed is worse than
# no check at all.
chk() {
  if [ -z "$2" ] && [ -n "$3" ]; then fail "$1" "<empty — command failed?>"; return; fi
  [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"
}
has() { case "$2" in *"$3"*) pass "$1";; *) fail "$1" "missing: $3";; esac; }

login() {
  j -c "$3" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}
q() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1 ?? ''"; }

OWNER_PASSWORD=${OWNER_PASSWORD:-'Phase8Owner2026!'}
MGR_PASSWORD=${MGR_PASSWORD:-'P8MgrPass2026!x'}
STAFF_PASSWORD=${STAFF_PASSWORD:-'P8StfPass2026!x'}

printf "════ Phase 9 setup ════\n"
login owner  "$OWNER_PASSWORD" "$O"
login p8mgr  "$MGR_PASSWORD"   "$M"
login p8staff "$STAFF_PASSWORD" "$S"
chk "owner session works" "$(c -b "$O" "$B/api/backups")" "200"

printf "\n════ §13.4 · permissions ════\n"
chk "MANAGER 403 on backup status"    "$(c -b "$M" "$B/api/backups")" "403"
chk "STAFF   403 on backup status"    "$(c -b "$S" "$B/api/backups")" "403"
chk "MANAGER 403 on download"         "$(c -b "$M" "$B/api/backups/download")" "403"
chk "STAFF   403 on download"         "$(c -b "$S" "$B/api/backups/download")" "403"
chk "MANAGER 403 on the screen"       "$(c -b "$M" "$B/settings/backups")" "403"
chk "STAFF   403 on the screen"       "$(c -b "$S" "$B/settings/backups")" "403"
chk "OWNER   200 on the screen"       "$(c -b "$O" "$B/settings/backups")" "200"
chk "MANAGER 403 recording a copy" \
  "$(c -b "$M" -X POST "$B/api/backups/offsite-copy" -H 'Content-Type: application/json' -d '{}')" "403"
chk "MANAGER 403 on the audit log"    "$(c -b "$M" "$B/api/audit-log")" "403"
chk "STAFF   403 on the audit log"    "$(c -b "$S" "$B/api/audit-log")" "403"
chk "MANAGER 403 on the audit screen" "$(c -b "$M" "$B/settings/audit-log")" "403"

printf "\n════ §13.1 · taking a backup ════\n"
BEFORE=$(ls backups/marblehouse-*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
RESP=$(j -b "$O" -X POST "$B/api/backups")
FILE=$(printf '%s' "$RESP" | q ".fileName")
chk "POST /api/backups returns a filename" "$(test -n "$FILE" && echo yes)" "yes"
chk "the archive exists on disk" "$(test -f "backups/$FILE" && echo yes)" "yes"
chk "a .sha256 sidecar was written" "$(test -f "backups/$FILE.sha256" && echo yes)" "yes"

# The sidecar must actually verify — a checksum that does not match its file is
# worse than none, because restore.sh trusts it.
SUMOK=$( (cd backups && shasum -a 256 -c "$FILE.sha256" >/dev/null 2>&1 && echo ok) )
chk "the sidecar checksum verifies" "$SUMOK" "ok"

# §13.1: three files, and a manifest with row counts.
ENTRIES=$(tar -tzf "backups/$FILE" | grep -c -E "database.dump|data.tar.gz|manifest.json")
chk "archive holds dump + data + manifest" "$ENTRIES" "3"

MANIFEST=$(tar -xzOf "backups/$FILE" ./manifest.json)
has "manifest records the schema migration" "$MANIFEST" "schemaMigration"
has "manifest records per-table row counts" "$MANIFEST" "tableCounts"
has "manifest records file checksums"       "$MANIFEST" "sha256"
SALE_ROWS=$(printf '%s' "$MANIFEST" | node -pe "
  const m=JSON.parse(require('fs').readFileSync(0,'utf8'));
  (m.tableCounts.find(t=>t.table==='Sale')||{}).rows ?? ''")
DB_SALES=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await p.sale.count())}finally{await p.\$disconnect()}})()")
chk "manifest Sale count matches the database" "$SALE_ROWS" "$DB_SALES"

# A BackupRun row is what the staleness alert reads. No row means no alarm.
RUNS=$(j -b "$O" "$B/api/backups" | q ".runs.length")
chk "a BackupRun row was written" "$(test "$RUNS" -ge 1 && echo yes)" "yes"
LAST_OK=$(j -b "$O" "$B/api/backups" | q ".runs[0].succeeded")
chk "the run is marked succeeded" "$LAST_OK" "true"

printf "\n════ §13.4 · one-tap download ════\n"
DL=$D/downloaded.tar.gz
HDRS=$(j -D - -b "$O" -o "$DL" "$B/api/backups/download")
has "download sets Content-Disposition" "$HDRS" "attachment"
has "download is not cached"            "$HDRS" "no-store"
LOCAL_SUM=$(shasum -a 256 "$DL" | cut -d' ' -f1)
DISK_SUM=$(shasum -a 256 "backups/$FILE" | cut -d' ' -f1)
chk "downloaded bytes match the archive" "$LOCAL_SUM" "$DISK_SUM"
chk "downloaded file is a valid archive" "$(tar -tzf "$DL" >/dev/null 2>&1 && echo ok)" "ok"

# The archive holds password hashes and customer phone numbers, so the filename
# must not be a path the caller controls.
chk "traversal ../../etc/passwd refused" \
  "$(c -b "$O" "$B/api/backups/download?file=../../../etc/passwd")" "404"
chk "traversal (encoded) refused" \
  "$(c -b "$O" "$B/api/backups/download?file=..%2f..%2fetc%2fpasswd")" "404"
chk "unknown archive name refused" \
  "$(c -b "$O" "$B/api/backups/download?file=nope.tar.gz")" "404"

printf "\n════ §13.4 · the off-machine copy log ════\n"
COPY=$(j -b "$O" -X POST "$B/api/backups/offsite-copy" \
  -H 'Content-Type: application/json' -d "{\"fileName\":\"$FILE\"}")
chk "the copy is recorded" "$(printf '%s' "$COPY" | q ".fileName")" "$FILE"
chk "status is green right after copying" \
  "$(j -b "$O" "$B/api/backups" | q ".status.offsiteLevel")" "green"
chk "health reports the copy timestamp" \
  "$(test -n "$(j "$B/api/health" | q ".backup.lastOffsiteCopyAt")" && echo yes)" "yes"

# The tap must be audit-logged — "I definitely copied it" needs a record.
AUDIT=$(j -b "$O" "$B/api/audit-log?entity=AppSetting&limit=1")
chk "the copy is audit-logged" "$(printf '%s' "$AUDIT" | q ".rows[0].entityId")" "lastOffsiteCopyAt"
chk "the audit row names the actor" \
  "$(test -n "$(printf '%s' "$AUDIT" | q ".rows[0].actor")" && echo yes)" "yes"

printf "\n════ §13.4 · the escalation ladder ════\n"
# Backdate the copy log and confirm each level, then the CRITICAL alert the
# owner dashboard reads. Restored to "now" at the end.
setcopy() {
  node -e "
    const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});
    (async()=>{try{
      const at=new Date(Date.now()-$1*86400000).toISOString();
      await p.appSetting.upsert({where:{key:'lastOffsiteCopyAt'},
        update:{value:{copiedAt:at,fileName:'$FILE'}},
        create:{key:'lastOffsiteCopyAt',value:{copiedAt:at,fileName:'$FILE'}}});
    }finally{await p.\$disconnect()}})()"
}
level() { j -b "$O" "$B/api/backups" | q ".status.offsiteLevel"; }

setcopy 3;  chk "3 days  → green" "$(level)" "green"
setcopy 6;  chk "6 days  → green" "$(level)" "green"
setcopy 7;  chk "7 days  → amber (inclusive)" "$(level)" "amber"
setcopy 13; chk "13 days → amber" "$(level)" "amber"
setcopy 14; chk "14 days → red (inclusive)" "$(level)" "red"
setcopy 16
chk "16 days → red" "$(level)" "red"

MSG=$(j -b "$O" "$B/api/backups" | q ".status.message")
has "the red message names the days lost" "$MSG" "16 days"
has "the red message names sales"         "$MSG" "sales"
has "the red message names balances"      "$MSG" "customer balances"
has "the red message names attendance"    "$MSG" "attendance records"

# §13.4 requires this to reach the owner's DASHBOARD, not just a settings page.
# Loading the backup screen syncs the alerts, which is what a real owner's
# visit does too — the state must not depend on a cron having fired.
j -b "$O" "$B/settings/backups" >/dev/null
DASH=$(j -b "$O" "$B/dashboard")
has "the red warning is on the owner dashboard" "$DASH" "16 days"

# The screen must offer NO way to dismiss the red state.
SCREEN=$(j -b "$O" "$B/settings/backups")
DISMISS=$(printf '%s' "$SCREEN" | grep -o -i "dismiss" | wc -l | tr -d ' ')
chk "the red banner has no dismiss control" "$DISMISS" "0"

# Tapping the button clears it immediately, not on the next cron.
j -b "$O" -X POST "$B/api/backups/offsite-copy" -H 'Content-Type: application/json' -d '{}' >/dev/null
chk "recording a copy clears the red state" "$(level)" "green"

printf "\n════ §13.2 · retention safety ════\n"
KEPT=$(j -b "$O" "$B/api/backups" | q ".status.archiveCount")
chk "at least one archive is kept" "$(test "$KEPT" -ge 1 && echo yes)" "yes"
# The safety floor is unit-tested against the real function in backup.test.ts —
# proving it here would mean creating and destroying 10 real archives.

printf "\n════ §13.3 · RESTORE, verified against the manifest ════\n"
printf "  restoring into scratch database %s …\n" "$SCRATCH_DB"
dropdb --if-exists "$SCRATCH_DB" 2>/dev/null
createdb "$SCRATCH_DB" 2>/dev/null

# refuse-without-force is checked on a database that HAS tables, further down.
RESTORE_OUT=$(
  DATABASE_URL="postgresql://$(whoami)@localhost:5432/$SCRATCH_DB" \
  DATA_DIR="$D/restored-data" \
  bash scripts/restore.sh "backups/$FILE" 2>&1
)
RESTORE_CODE=$?
chk "restore.sh exits 0 on a clean database" "$RESTORE_CODE" "0"
has "restore verified the archive checksum" "$RESTORE_OUT" "checksum verified"
has "restore printed the row-count table"   "$RESTORE_OUT" "manifest vs restored"
has "every table matched the manifest"      "$RESTORE_OUT" "Every table matches the manifest exactly"

# Independent confirmation: count in the restored database directly rather than
# trusting the script's own output.
RESTORED_SALES=$(psql "postgresql://$(whoami)@localhost:5432/$SCRATCH_DB" -tAc 'SELECT COUNT(*) FROM "Sale";' 2>/dev/null | tr -d ' ')
chk "restored Sale count matches the manifest" "$RESTORED_SALES" "$SALE_ROWS"
RESTORED_CUST=$(psql "postgresql://$(whoami)@localhost:5432/$SCRATCH_DB" -tAc 'SELECT COUNT(*) FROM "Customer";' 2>/dev/null | tr -d ' ')
DB_CUST=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await p.customer.count())}finally{await p.\$disconnect()}})()")
chk "restored Customer count matches source" "$RESTORED_CUST" "$DB_CUST"

# The data directory (photos, receipts) must come back too.
RESTORED_FILES=$(find "$D/restored-data" -type f 2>/dev/null | wc -l | tr -d ' ')
SOURCE_FILES=$(find data -type f 2>/dev/null | wc -l | tr -d ' ')
chk "attendance photos and receipts restored" "$RESTORED_FILES" "$SOURCE_FILES"

printf "\n════ §13.3 · restore refuses to destroy data ════\n"
# The database now has tables, so a second restore without --force must refuse.
# NOTE: this script runs without `set -e` on purpose (only `set -u` at the top).
# Several checks below deliberately run a command that MUST fail, and errexit
# would abort the run at the first of them — which is exactly what happened the
# first time this was written.
DATABASE_URL="postgresql://$(whoami)@localhost:5432/$SCRATCH_DB" \
DATA_DIR="$D/restored-data" \
bash scripts/restore.sh "backups/$FILE" >/dev/null 2>&1
REFUSE_CODE=$?
chk "refuses a non-empty database without --force" "$REFUSE_CODE" "1"

# A corrupt archive must never reach pg_restore.
cp "backups/$FILE" "$D/corrupt.tar.gz"
cp "backups/$FILE.sha256" "$D/corrupt.tar.gz.sha256"
sed -i '' "s/$FILE/corrupt.tar.gz/" "$D/corrupt.tar.gz.sha256" 2>/dev/null || \
  sed -i "s/$FILE/corrupt.tar.gz/" "$D/corrupt.tar.gz.sha256"
printf 'GARBAGE' | dd of="$D/corrupt.tar.gz" bs=1 seek=5000 conv=notrunc 2>/dev/null
CORRUPT_OUT=$(DATABASE_URL="postgresql://$(whoami)@localhost:5432/$SCRATCH_DB" \
  bash scripts/restore.sh "$D/corrupt.tar.gz" --force 2>&1)
CORRUPT_CODE=$?
chk "a corrupt archive is refused" "$CORRUPT_CODE" "1"
has "and says so plainly" "$CORRUPT_OUT" "corrupt"

# §13.3's actual point: a restore that quietly loses rows must FAIL.
mkdir -p "$D/lossy" && tar -xzf "backups/$FILE" -C "$D/lossy"
node -e "
  const fs=require('fs'),c=require('crypto');const p='$D/lossy/manifest.json';
  const m=JSON.parse(fs.readFileSync(p));
  m.tableCounts.find(t=>t.table==='Sale').rows += 90;
  for(const f of m.files) f.sha256=c.createHash('sha256').update(fs.readFileSync('$D/lossy/'+f.name)).digest('hex');
  fs.writeFileSync(p,JSON.stringify(m,null,2));
"
tar -czf "$D/lossy.tar.gz" -C "$D/lossy" .
LOSSY_OUT=$(DATABASE_URL="postgresql://$(whoami)@localhost:5432/$SCRATCH_DB" \
  DATA_DIR="$D/restored-data" bash scripts/restore.sh "$D/lossy.tar.gz" --force 2>&1)
LOSSY_CODE=$?
chk "a restore missing 90 rows FAILS" "$LOSSY_CODE" "1"
has "and names the incomplete restore" "$LOSSY_OUT" "INCOMPLETE"

dropdb --if-exists "$SCRATCH_DB" 2>/dev/null
printf "  scratch database dropped\n"

printf "\n════ §11 · jobs and health ════\n"
HEALTH=$(j "$B/api/health")
has "health reports lastLocalBackupAt"  "$HEALTH" "lastLocalBackupAt"
has "health reports lastOffsiteCopyAt"  "$HEALTH" "lastOffsiteCopyAt"
chk "health is still ok" "$(printf '%s' "$HEALTH" | q ".status")" "ok"
# The archive holds password hashes — an UNAUTHENTICATED endpoint must not name it.
UNAUTH=$(j "$B/api/health")
NOFILE=$(printf '%s' "$UNAUTH" | grep -o "marblehouse-2026" | wc -l | tr -d ' ')
chk "health leaks no archive filename" "$NOFILE" "0"

printf "\n════ §8.10 · business-day hour ════\n"
chk "MANAGER 403 on the hour setting" \
  "$(c -b "$M" "$B/api/settings/business-day-start-hour")" "403"
HOUR_BEFORE=$(j -b "$O" "$B/api/settings/business-day-start-hour" | q ".hour")
chk "owner reads the hour" "$(test -n "$HOUR_BEFORE" && echo yes)" "yes"
chk "hour 24 is rejected" \
  "$(c -b "$O" -X PATCH "$B/api/settings/business-day-start-hour" \
     -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d '{"hour":24}')" "422"
j -b "$O" -X PATCH "$B/api/settings/business-day-start-hour" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d '{"hour":5}' >/dev/null
chk "the hour changed" "$(j -b "$O" "$B/api/settings/business-day-start-hour" | q ".hour")" "5"
HOUR_AUDIT=$(j -b "$O" "$B/api/audit-log?entity=AppSetting&limit=1")
chk "the change is audit-logged with the OLD value" \
  "$(printf '%s' "$HOUR_AUDIT" | q ".rows[0].before.hour")" "$HOUR_BEFORE"
j -b "$O" -X PATCH "$B/api/settings/business-day-start-hour" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "{\"hour\":$HOUR_BEFORE}" >/dev/null
chk "the hour was restored" "$(j -b "$O" "$B/api/settings/business-day-start-hour" | q ".hour")" "$HOUR_BEFORE"

printf "\n════ §4.16 · audit log viewer ════\n"
AL=$(j -b "$O" "$B/api/audit-log?limit=5")
chk "the owner can read the log" "$(test -n "$(printf '%s' "$AL" | q ".rows[0].id")" && echo yes)" "yes"
has "rows carry an action" "$AL" "action"
chk "the screen renders for the owner" "$(c -b "$O" "$B/settings/audit-log")" "200"
# The log is append-only (§4.16) — there must be no way to write to it.
chk "POST to the audit log is not allowed" \
  "$(c -b "$O" -X POST "$B/api/audit-log" -H 'Content-Type: application/json' -d '{}')" "405"
chk "DELETE on the audit log is not allowed" \
  "$(c -b "$O" -X DELETE "$B/api/audit-log")" "405"

rm -rf "$D"
printf "\n"
if [ "$FAILED" -eq 0 ]; then
  printf "\033[32m════ Phase 9: PASS ════\033[0m\n"
  printf "Still outstanding: the §16 rehearsal on a SECOND PHYSICAL MACHINE.\n"
  printf "This script restores into a scratch database on THIS machine only.\n"
  exit 0
else
  printf "\033[31m════ Phase 9: FAIL ════\033[0m\n"
  exit 1
fi
