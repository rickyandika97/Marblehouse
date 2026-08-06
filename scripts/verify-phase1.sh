#!/bin/bash
# Phase 1 acceptance criteria — end-to-end against a freshly seeded database.
cd /Users/ricky/redlight
B=http://localhost:5050
D=/private/tmp/claude-501/-Users-ricky-redlight/79ef0799-c699-48b5-9004-1287ff5a1420/scratchpad
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt
rm -f $O $M $S
SEEDPW=$(grep SEED_OWNER_PASSWORD .env | cut -d= -f2)

j() { curl -s "$@"; }          # json
c() { curl -s -o /dev/null -w "%{http_code}" "$@"; }  # status only

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }

echo "════ 1. Log in as owner, manager and staff ════"

# Owner: first login forces a password change.
j -c $O -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"owner\",\"password\":\"$SEEDPW\"}" > $D/r.json
grep -q '"mustChangePassword":true' $D/r.json \
  && pass "owner first login demands a password change" \
  || fail "owner first login demands a password change" "$(cat $D/r.json)"

j -b $O -c $O -X POST $B/api/auth/change-password -H 'Content-Type: application/json' \
  -d '{"newPassword":"OwnerRealPass2026!"}' >/dev/null
rm -f $O
LAND=$(j -c $O -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"owner","password":"OwnerRealPass2026!"}' | grep -o '"landingPath":"[^"]*"' | cut -d'"' -f4)
chk "OWNER lands on /dashboard" "$LAND" "/dashboard"

# Owner needs a shop for today before creating users.
SHOP=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.shop.findFirst({where:{code:'BR-1'}}).then(s=>{console.log(s.id);p.\$disconnect()})" 2>/dev/null)
j -b $O -X POST $B/api/work-session -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\"}" >/dev/null

# Create a manager and a staff member through the owner's screen API.
j -b $O -X POST $B/api/users -H 'Content-Type: application/json' \
  -d "{\"username\":\"manager1\",\"displayName\":\"Manager One\",\"password\":\"TempMgr2026!\",\"role\":\"MANAGER\",\"shopIds\":[\"$SHOP\"],\"canEnterCost\":false}" > $D/mgr.json
grep -q '"role":"MANAGER"' $D/mgr.json && pass "owner creates a manager account" \
  || fail "owner creates a manager account" "$(head -c 120 $D/mgr.json)"

j -b $O -X POST $B/api/users -H 'Content-Type: application/json' \
  -d "{\"username\":\"staff1\",\"displayName\":\"Staff One\",\"password\":\"TempStaff2026!\",\"role\":\"STAFF\",\"shopIds\":[\"$SHOP\"]}" > $D/stf.json
grep -q '"role":"STAFF"' $D/stf.json && pass "owner creates a staff account" \
  || fail "owner creates a staff account" "$(head -c 120 $D/stf.json)"

# Manager + staff: clear the forced change, then log in for real.
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
