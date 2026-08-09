#!/bin/bash
# Phase 1 acceptance criteria — end-to-end against a freshly seeded database.
# Resolve the repo from this script's own location, like every other
# verify-phase script. It used to `cd` to an absolute path under the project's
# former name (`redlight`), which worked only by accident on the machine it was
# written on.
cd "$(dirname "$0")/.." || exit 1
B=http://localhost:5050
# A fresh temp dir per run. This was previously a hardcoded path into one
# session's scratchpad; once that directory was gone every cookie jar and
# response file silently failed to write, and all 21 checks reported red with
# nothing actually broken (D-96).
D=$(mktemp -d)
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt
SEEDPW=$(grep SEED_OWNER_PASSWORD .env | cut -d= -f2)

j() { curl -s "$@"; }          # json
c() { curl -s -o /dev/null -w "%{http_code}" "$@"; }  # status only

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }

echo "════ 1. Log in as owner, manager and staff ════"

# ── Re-runnability ───────────────────────────────────────────────────────────
# The forced first-login change can only be observed ONCE per seeded database,
# and creating manager1/staff1 collides on a second run. This script used to
# assume a virgin database, so running the whole suite twice in a row reported
# three red checks with nothing broken — which is exactly the trap that hides a
# real regression in the noise (D-96).
#
# So: perform the first-run assertion when the database is genuinely fresh, and
# SKIP it (loudly) when it is not, rather than failing.
j -c $O -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"owner\",\"password\":\"$SEEDPW\"}" > $D/r.json

if grep -q '"mustChangePassword":true' $D/r.json; then
  pass "owner first login demands a password change"
  j -b $O -c $O -X POST $B/api/auth/change-password -H 'Content-Type: application/json' \
    -d '{"newPassword":"OwnerRealPass2026!"}' >/dev/null
elif j -c $O -X POST $B/api/auth/login -H 'Content-Type: application/json' \
      -d '{"username":"owner","password":"OwnerRealPass2026!"}' \
      | grep -q '"landingPath"'; then
  printf "  \033[33m•\033[0m %s\n" \
    "owner first login demands a password change  (SKIPPED — already changed by an earlier run)"
else
  fail "owner first login demands a password change" "$(cat $D/r.json)"
fi
rm -f $O
LAND=$(j -c $O -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"owner","password":"OwnerRealPass2026!"}' | grep -o '"landingPath":"[^"]*"' | cut -d'"' -f4)
chk "OWNER lands on /dashboard" "$LAND" "/dashboard"

# Owner needs a shop for today before creating users.
SHOP=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.shop.findFirst({where:{code:'BR-1'}}).then(s=>{console.log(s.id);p.\$disconnect()})" 2>/dev/null)
j -b $O -X POST $B/api/work-session -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\"}" >/dev/null

# Create a manager and a staff member through the owner's screen API.
#
# A 409 CONFLICT here means an earlier run already created them, which is a
# PASS for "the owner can create accounts" — the account demonstrably exists.
# Treating it as a failure is what made a second sequential run look broken
# (D-96). A genuine failure (403, 422, 500) still fails.
mkuser() { # label file json-body role
  if grep -q "\"role\":\"$4\"" "$2"; then
    pass "$1"
  elif grep -q '"code":"CONFLICT"' "$2"; then
    printf "  \033[33m•\033[0m %s\n" "$1  (already existed from an earlier run)"
  else
    fail "$1" "$(head -c 120 "$2")"
  fi
}

j -b $O -X POST $B/api/users -H 'Content-Type: application/json' \
  -d "{\"username\":\"manager1\",\"displayName\":\"Manager One\",\"password\":\"TempMgr2026!\",\"role\":\"MANAGER\",\"shopIds\":[\"$SHOP\"],\"canEnterCost\":false}" > $D/mgr.json
mkuser "owner creates a manager account" "$D/mgr.json" "" MANAGER

j -b $O -X POST $B/api/users -H 'Content-Type: application/json' \
  -d "{\"username\":\"staff1\",\"displayName\":\"Staff One\",\"password\":\"TempStaff2026!\",\"role\":\"STAFF\",\"shopIds\":[\"$SHOP\"]}" > $D/stf.json
mkuser "owner creates a staff account" "$D/stf.json" "" STAFF

# Manager + staff: clear the forced change, then log in for real. On a re-run
# the temp password is already spent, so fall back to the settled one.
for U in "manager1:TempMgr2026!:MgrRealPass2026!:$M" "staff1:TempStaff2026!:StaffRealPass2026!:$S"; do
  IFS=: read -r NAME TMP NEW JAR <<< "$U"
  j -c $JAR -X POST $B/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"username\":\"$NAME\",\"password\":\"$TMP\"}" >/dev/null
  j -b $JAR -c $JAR -X POST $B/api/auth/change-password -H 'Content-Type: application/json' \
    -d "{\"newPassword\":\"$NEW\"}" >/dev/null
  rm -f $JAR
  L=$(j -c $JAR -X POST $B/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"username\":\"$NAME\",\"password\":\"$NEW\"}" | grep -o '"landingPath":"[^"]*"' | cut -d'"' -f4)
  chk "$NAME lands on /sale" "$L" "/sale"
done

echo
echo "════ 2. Shop picker: first login of each business day ════"
chk "single-shop STAFF skips the picker entirely" \
  "$(c -b $S $B/sale)" "200"
chk "single-shop MANAGER skips the picker entirely" \
  "$(c -b $M $B/sale)" "200"

# Owner has 2 shops after we add one, so the picker must appear.
node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.shop.upsert({where:{code:'BR-2'},update:{},create:{code:'BR-2',name:'Branch 2'}}).then(()=>p.workSession.deleteMany()).then(()=>p.\$disconnect())" 2>/dev/null
REDIR=$(curl -s -o /dev/null -w "%{redirect_url}" -b $O $B/dashboard)
[ "$REDIR" = "$B/select-shop" ] \
  && pass "multi-shop user is sent to the picker when no session exists today" \
  || fail "multi-shop user is sent to the picker" "$REDIR"

PRE=$(j -b $O $B/api/auth/me | grep -o '"defaultShopId":"[^"]*"' | cut -d'"' -f4)
[ "$PRE" = "$SHOP" ] && pass "picker pre-selects the user's default shop" \
  || fail "picker pre-selects the default shop" "$PRE"

j -b $O -X POST $B/api/work-session -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\"}" >/dev/null
chk "picker does not reappear later the same day" "$(c -b $O $B/dashboard)" "200"

echo
echo "════ 3. Change current shop from Settings, audit-logged ════"
SHOP2=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.shop.findFirst({where:{code:'BR-2'}}).then(s=>{console.log(s.id);p.\$disconnect()})" 2>/dev/null)
j -b $O -X PATCH $B/api/work-session -H 'Content-Type: application/json' \
  -d "{\"shopId\":\"$SHOP2\"}" > $D/chg.json
grep -q '"shopName":"Branch 2"' $D/chg.json && pass "owner changes today's shop from Settings" \
  || fail "owner changes shop" "$(head -c 120 $D/chg.json)"

AUD=$(node -e "
const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});
p.auditLog.findFirst({where:{entity:'WorkSession',action:'CHANGE_SHOP'},orderBy:{occurredAt:'desc'}}).then(r=>{
  console.log(r ? (r.before?.shopName+' -> '+r.after?.shopName) : 'NONE'); p.\$disconnect();})" 2>/dev/null)
[ "$AUD" = "Branch 1 -> Branch 2" ] && pass "shop change is audit-logged with old and new shop" \
  || fail "shop change audit row" "$AUD"

echo
echo "════ 4. Staff gets 403 on an admin URL typed into the address bar ════"
chk "STAFF  GET /settings/users -> 403" "$(c -b $S $B/settings/users)" "403"
chk "STAFF  GET /dashboard      -> 403" "$(c -b $S $B/dashboard)" "403"
chk "STAFF  GET /api/users      -> 403" "$(c -b $S $B/api/users)" "403"
chk "STAFF  POST /api/users     -> 403 (no privilege escalation)" \
  "$(c -b $S -X POST $B/api/users -H 'Content-Type: application/json' -d '{"username":"x","displayName":"X","password":"Whatever2026!","role":"OWNER","shopIds":[]}')" "403"
chk "MANAGER GET /settings/users -> 403" "$(c -b $M $B/settings/users)" "403"
chk "MANAGER GET /dashboard      -> 200 (allowed)" "$(c -b $M $B/dashboard)" "200"
chk "OWNER   GET /settings/users -> 200 (control)" "$(c -b $O $B/settings/users)" "200"

echo
echo "════ 5. Shop scoping and session hygiene ════"
chk "STAFF cannot claim a shop outside their assignments" \
  "$(c -b $S -X POST $B/api/work-session -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP2\"}")" "403"
chk "unauthenticated API returns 401 JSON, not an HTML redirect" \
  "$(c $B/api/users)" "401"
chk "unauthenticated page redirects to /login" "$(c $B/dashboard)" "307"

echo
[ -z "$FAILED" ] && printf "\033[32m════ ALL PHASE 1 ACCEPTANCE CRITERIA PASS ════\033[0m\n" \
                 || printf "\033[31m════ SOME CHECKS FAILED ════\033[0m\n"
