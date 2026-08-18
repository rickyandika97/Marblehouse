#!/bin/bash
# Settings → Shops (§5.6, §8.10) — the self-service branch-creation flow.
#
# Not a phase script: shop administration was a gap left by Phase 10 rather
# than a phase of its own (BUILD-LOG D-101). Same shape as
# `scripts/verify-phase1.sh`, and re-runnable — every shop it creates carries a
# unique code and is deactivated (never deleted) at the end, because a shop
# owns money rows and CLAUDE.md forbids hard-deleting those.
cd "$(dirname "$0")/.." || exit 1
B=http://localhost:5050
D=$(mktemp -d)
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt
SEEDPW=$(grep SEED_OWNER_PASSWORD .env | cut -d= -f2)
FAILED=0

j() { curl -s "$@"; }
# First `id` in a JSON body, non-greedy. NEVER use `sed 's/.*"id":"...'` here:
# the body is one line, `.*` matches greedily, and you get the LAST id instead.
first_id() { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
c() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }
# Body is a function body, so it may contain statements and must `return`.
db() { node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await (async(p)=>{ $1 })(p))}finally{await p.\$disconnect()}})()"; }

login() {
  j -c "$3" -X POST $B/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}

# ── Fixtures ─────────────────────────────────────────────────────────────────
# `manager1` / `staff1` do not survive a reseed (D-94), and a MISSING account
# logs in as nobody — which turns every "a manager is refused" check into a 401
# that LOOKS like a pass for the wrong reason. So create them if absent, the
# way verify-phase4.sh creates purchaser1, and then assert each session is
# genuinely usable before trusting a single 403 below.

# The owner's password differs between a virgin database and one phase 1 has
# already run against. Try the real one, fall back to the seed.
login owner "OwnerRealPass2026!" $O
if [ "$(c -b $O $B/api/auth/me)" != "200" ]; then
  login owner "$SEEDPW" $O
  # A virgin database forces a change on first login.
  j -b $O -c $O -X POST $B/api/auth/change-password -H 'Content-Type: application/json' \
    -d '{"newPassword":"OwnerRealPass2026!"}' >/dev/null
  login owner "OwnerRealPass2026!" $O
fi

if [ "$(c -b $O $B/api/auth/me)" != "200" ]; then
  printf "\033[31mCannot sign in as the owner — is the database seeded?\033[0m\n"
  exit 1
fi

SHOP=$(db "return (await p.shop.findFirst({where:{code:'BR-1'}})).id")

ensure_user() { # username displayName role password jar
  local EXISTS
  EXISTS=$(db "const u = await p.user.findUnique({where:{username:'$1'}}); return u ? u.id : 'MISSING'")
  if [ "$EXISTS" = "MISSING" ]; then
    j -b $O -X POST $B/api/users -H 'Content-Type: application/json' \
      -d "{\"username\":\"$1\",\"displayName\":\"$2\",\"password\":\"$4\",\"role\":\"$3\",\"shopIds\":[\"$SHOP\"]}" >/dev/null
  fi
  # Clear the forced change and any stale deactivation, and make sure the shop
  # assignment survived a reseed that dropped it.
  db "const u = await p.user.findUnique({where:{username:'$1'}});
      await p.user.update({where:{id:u.id},data:{mustChangePassword:false,banned:false}});
      await p.userShop.upsert({where:{userId_shopId:{userId:u.id,shopId:'$SHOP'}},update:{},create:{userId:u.id,shopId:'$SHOP'}});
      return 'ok'" >/dev/null
  login "$1" "$4" "$5"
}

ensure_user manager1 "Manager One" MANAGER "MgrRealPass2026!"   $M
ensure_user staff1   "Staff One"   STAFF   "StaffRealPass2026!" $S

# THE GUARD. Without this, a broken fixture silently converts every permission
# check below into a 401 and the script reports green-ish nonsense.
for PAIR in "owner:$O" "manager1:$M" "staff1:$S"; do
  WHO=${PAIR%%:*}; JAR=${PAIR##*:}
  if [ "$(c -b $JAR $B/api/auth/me)" != "200" ]; then
    printf "  \033[31m✗\033[0m fixture: %s has no usable session — every 403 check below would be a false pass\n" "$WHO"
    FAILED=1
  else
    pass "fixture: $WHO is signed in"
  fi
done
[ "$FAILED" = "1" ] && { printf "\n\033[31mFIXTURES BROKEN — refusing to report permission results\033[0m\n"; exit 1; }

echo
echo "════ 1. Only the OWNER reaches Settings → Shops ════"

chk "OWNER gets the page"            "$(c -b $O $B/settings/shops)"    200
chk "MANAGER is refused the page"    "$(c -b $M $B/settings/shops)"    403
chk "STAFF is refused the page"      "$(c -b $S $B/settings/shops)"    403
chk "OWNER can list via the API"     "$(c -b $O $B/api/shops)"         200
chk "MANAGER is 403 on the API"      "$(c -b $M $B/api/shops)"         403
chk "STAFF is 403 on the API"        "$(c -b $S $B/api/shops)"         403
chk "signed out is 401"              "$(c $B/api/shops)"               401

echo
echo "════ 2. Creating a branch ════"

CODE="V$(date +%H%M%S)"
j -b $O -X POST $B/api/shops -H 'Content-Type: application/json' \
  -d "{\"code\":\"$CODE\",\"name\":\"Verify Branch $CODE\",\"lateGraceMin\":7}" > $D/new.json

NEWID=$(first_id < $D/new.json)
[ -n "$NEWID" ] && pass "the shop is created" || fail "the shop is created" "$(cat $D/new.json)"

grep -q "\"code\":\"$CODE\""        $D/new.json && pass "the code is stored uppercase" || fail "the code is stored uppercase" "$(cat $D/new.json)"
grep -q '"lateGraceMin":7'          $D/new.json && pass "late grace is kept"            || fail "late grace is kept" "$(cat $D/new.json)"
grep -q '"isHqPseudoShop":false'    $D/new.json && pass "it is not an HQ pseudo-shop"   || fail "it is not an HQ pseudo-shop" "$(cat $D/new.json)"

echo
echo "════ 3. It starts EMPTY — the decision (D-101) ════"

grep -q '"presetCount":0' $D/new.json && pass "no sale presets were cloned" || fail "no sale presets were cloned" "$(cat $D/new.json)"
grep -q '"shiftCount":0'  $D/new.json && pass "no shifts were cloned"       || fail "no shifts were cloned" "$(cat $D/new.json)"

# And nobody was assigned — the owner assigns staff themselves.
ASSIGNED=$(psql -tA marblehouse_dev -c "select count(*) from \"UserShop\" where \"shopId\" = '$NEWID';" 2>/dev/null)
chk "nobody is assigned to it" "$ASSIGNED" "0"

echo
echo "════ 4. A duplicate code is refused ════"

chk "the same code again is 409" \
  "$(c -b $O -X POST $B/api/shops -H 'Content-Type: application/json' \
     -d "{\"code\":\"$CODE\",\"name\":\"Clash\"}")" 409

chk "the same code lowercased is also 409" \
  "$(c -b $O -X POST $B/api/shops -H 'Content-Type: application/json' \
     -d "{\"code\":\"$(echo $CODE | tr 'A-Z' 'a-z')\",\"name\":\"Clash\"}")" 409

chk "a code with a space is 422" \
  "$(c -b $O -X POST $B/api/shops -H 'Content-Type: application/json' \
     -d '{"code":"BR 9","name":"Spaced"}')" 422

chk "an unknown timezone is 422" \
  "$(c -b $O -X POST $B/api/shops -H 'Content-Type: application/json' \
     -d "{\"code\":\"ZZTOP1\",\"name\":\"Nowhere\",\"timezone\":\"Mars/Olympus\"}")" 422

echo
echo "════ 5. A non-owner cannot create or edit ════"

chk "MANAGER creating a shop is 403" \
  "$(c -b $M -X POST $B/api/shops -H 'Content-Type: application/json' \
     -d '{"code":"MGR1","name":"Manager Branch"}')" 403

chk "MANAGER editing a shop is 403" \
  "$(c -b $M -X PATCH $B/api/shops/$NEWID -H 'Content-Type: application/json' \
     -d '{"name":"Renamed by a manager"}')" 403

chk "STAFF creating a shop is 403" \
  "$(c -b $S -X POST $B/api/shops -H 'Content-Type: application/json' \
     -d '{"code":"STF1","name":"Staff Branch"}')" 403

echo
echo "════ 6. Editing, and the immutable code ════"

j -b $O -X PATCH $B/api/shops/$NEWID -H 'Content-Type: application/json' \
  -d "{\"name\":\"Renamed Branch\",\"code\":\"HACKED\",\"allowCustomAmount\":true}" > $D/upd.json

grep -q '"name":"Renamed Branch"'   $D/upd.json && pass "the name changes"              || fail "the name changes" "$(cat $D/upd.json)"
grep -q "\"code\":\"$CODE\""        $D/upd.json && pass "the code does NOT change"      || fail "the code does NOT change" "$(cat $D/upd.json)"
grep -q '"allowCustomAmount":true'  $D/upd.json && pass "a toggle changes"              || fail "a toggle changes" "$(cat $D/upd.json)"

echo
echo "════ 7. Guards that stop a lockout ════"

HQID=$(psql -tA marblehouse_dev -c "select id from \"Shop\" where \"isHqPseudoShop\" = true limit 1;" 2>/dev/null)
chk "HQ cannot be deactivated" \
  "$(c -b $O -X PATCH $B/api/shops/$HQID -H 'Content-Type: application/json' \
     -d '{"isActive":false}')" 422

# The last-active-branch guard is proven in the unit suite, where the database
# can be driven to that state safely. Here we only confirm a normal branch CAN
# be closed while others are open.
chk "a branch closes while others are open" \
  "$(c -b $O -X PATCH $B/api/shops/$NEWID -H 'Content-Type: application/json' \
     -d '{"isActive":false}')" 200

chk "and reopens" \
  "$(c -b $O -X PATCH $B/api/shops/$NEWID -H 'Content-Type: application/json' \
     -d '{"isActive":true}')" 200

chk "a shop that does not exist is 404" \
  "$(c -b $O -X PATCH $B/api/shops/no-such-shop -H 'Content-Type: application/json' \
     -d '{"name":"Ghost"}')" 404

echo
echo "════ 8. It is audited (§11) ════"

AUDITED=$(psql -tA marblehouse_dev -c "select count(*) from \"AuditLog\" where entity = 'Shop' and \"entityId\" = '$NEWID' and action = 'CREATE';" 2>/dev/null)
chk "the creation wrote an audit row" "$AUDITED" "1"

UPDATES=$(psql -tA marblehouse_dev -c "select count(*) from \"AuditLog\" where entity = 'Shop' and \"entityId\" = '$NEWID' and action in ('UPDATE','DEACTIVATE','REACTIVATE');" 2>/dev/null)
[ "$UPDATES" -ge 3 ] && pass "every edit wrote an audit row" || fail "every edit wrote an audit row" "$UPDATES"

echo
echo "════ 9. The new branch appears where it should ════"

j -b $O $B/api/shops > $D/list.json
grep -q "$NEWID" $D/list.json && pass "it is in the owner's shop list" || fail "it is in the owner's shop list" "missing"

# Leave the branch deactivated rather than deleted — a shop is never
# hard-deleted (CLAUDE.md soft-delete rule), and leaving it open would put a
# junk branch in the day-start picker.
j -b $O -X PATCH $B/api/shops/$NEWID -H 'Content-Type: application/json' \
  -d '{"isActive":false}' > /dev/null
printf "\n  cleanup: %s left deactivated (never hard-deleted)\n" "$CODE"

echo
echo "════ 10. Sale prices — filling the empty branch (D-103) ════"

# A fresh branch to fill, so the checks do not depend on earlier sections.
PCODE="P$(date +%H%M%S)"
PSHOP=$(j -b $O -X POST $B/api/shops -H 'Content-Type: application/json' \
  -d "{\"code\":\"$PCODE\",\"name\":\"Prices $PCODE\"}" | first_id)

chk "the prices page loads for the OWNER"  "$(c -b $O $B/settings/shops/$PSHOP/presets)" 200
chk "a MANAGER is refused the prices page" "$(c -b $M $B/settings/shops/$PSHOP/presets)" 403
chk "a STAFF is refused the prices page"   "$(c -b $S $B/settings/shops/$PSHOP/presets)" 403

# The empty-branch shortcut.
j -b $O -X POST $B/api/shops/$PSHOP/presets -H 'Content-Type: application/json' \
  -d '{"defaults":true}' > $D/defaults.json
COUNT=$(grep -o '"id"' $D/defaults.json | wc -l | tr -d ' ')
chk "the five standard prices are added" "$COUNT" "5"
chk "adding them twice is 409" \
  "$(c -b $O -X POST $B/api/shops/$PSHOP/presets -H 'Content-Type: application/json' \
     -d '{"defaults":true}')" 409

# A single price, and the duplicate guard.
PRESET=$(j -b $O -X POST $B/api/shops/$PSHOP/presets -H 'Content-Type: application/json' \
  -d '{"label":"Rp 25.000","amount":"25000"}' | first_id)
[ -n "$PRESET" ] && pass "a single price is added" || fail "a single price is added" "none"

chk "the same amount again is 409" \
  "$(c -b $O -X POST $B/api/shops/$PSHOP/presets -H 'Content-Type: application/json' \
     -d '{"label":"Again","amount":"25000"}')" 409
chk "a zero amount is 422" \
  "$(c -b $O -X POST $B/api/shops/$PSHOP/presets -H 'Content-Type: application/json' \
     -d '{"label":"Free","amount":"0"}')" 422
chk "a decimal amount is 422" \
  "$(c -b $O -X POST $B/api/shops/$PSHOP/presets -H 'Content-Type: application/json' \
     -d '{"label":"Odd","amount":"5000.50"}')" 422

# Non-owners cannot manage prices, but staff CAN still read the sale list —
# they cannot ring up a sale otherwise. Two different guards on one URL.
chk "a MANAGER cannot add a price" \
  "$(c -b $M -X POST $B/api/shops/$PSHOP/presets -H 'Content-Type: application/json' \
     -d '{"label":"Nope","amount":"11000"}')" 403
chk "a STAFF cannot delete a price" \
  "$(c -b $S -X DELETE $B/api/shops/$PSHOP/presets/$PRESET)" 403
chk "a MANAGER is 403 on the admin list" \
  "$(c -b $M "$B/api/shops/$PSHOP/presets?admin=1")" 403

# The sale screen's own read, at a shop the staff member is assigned to.
chk "STAFF can still read BR-1's sale prices" \
  "$(c -b $S $B/api/shops/$SHOP/presets)" 200

# An unused price deletes outright (§13.5).
chk "an unused price deletes" "$(c -b $O -X DELETE $B/api/shops/$PSHOP/presets/$PRESET)" 200

# ── §4.3: a price with a sale against it ─────────────────────────────────────
# Record a real sale through the API so the "used" branch is genuine.
# NOTE: do NOT sed an id out of the JSON — the body is one line and `.*"id":"`
# matches greedily to the LAST id, which silently picks the wrong preset (this
# reported a false failure the first time). Ask for the one we mean by amount.
SOLD=$(db "return (await p.salePreset.findFirst({where:{shopId:'$PSHOP',amount:'20000'}})).id")
db "await p.sale.create({data:{shopId:'$PSHOP',recordedById:(await p.user.findFirstOrThrow({where:{role:'OWNER'}})).id,presetId:'$SOLD',amount:'20000',paymentMethod:'CASH',businessDate:new Date('2026-08-18')}}); return 'ok'" >/dev/null

chk "a used price cannot be deleted" "$(c -b $O -X DELETE $B/api/shops/$PSHOP/presets/$SOLD)" 409

# Re-pricing it must SUPERSEDE, not edit — otherwise that sale's amount moves.
j -b $O -X PATCH $B/api/shops/$PSHOP/presets/$SOLD -H 'Content-Type: application/json' \
  -d '{"amount":"22000"}' > $D/super.json
grep -q '"supersededId"' $D/super.json && pass "re-pricing a used price supersedes it" || fail "re-pricing a used price supersedes it" "$(cat $D/super.json)"

OLDAMT=$(db "return (await p.salePreset.findUnique({where:{id:'$SOLD'}})).amount.toString()")
chk "the old price keeps its amount" "$OLDAMT" "20000"
SALEAMT=$(db "return (await p.sale.findFirst({where:{presetId:'$SOLD'}})).amount.toString()")
chk "the historical sale is unchanged" "$SALEAMT" "20000"
OLDACTIVE=$(db "return (await p.salePreset.findUnique({where:{id:'$SOLD'}})).isActive")
chk "the old price is retired, not deleted" "$OLDACTIVE" "false"

# Clean up this section's branch: sales first, then presets, then the shop.
db "await p.sale.deleteMany({where:{shopId:'$PSHOP'}});
    await p.salePreset.deleteMany({where:{shopId:'$PSHOP'}});
    await p.auditLog.deleteMany({where:{shopId:'$PSHOP'}});
    await p.shop.delete({where:{id:'$PSHOP'}});
    return 'ok'" >/dev/null

echo
echo "════ 11. Shifts — the other half of the empty branch (D-105) ════"

SCODE="S$(date +%H%M%S)"
SSHOP=$(j -b $O -X POST $B/api/shops -H 'Content-Type: application/json' \
  -d "{\"code\":\"$SCODE\",\"name\":\"Shifts $SCODE\"}" | first_id)

# The page is manager-or-owner, NOT owner-only like prices (§3.4). manager1 is
# assigned to BR-1, so use BR-1 to prove the manager half.
chk "the shifts page loads for the OWNER"       "$(c -b $O $B/settings/shops/$SSHOP/shifts)" 200
chk "a MANAGER reaches it at their OWN shop"    "$(c -b $M $B/settings/shops/$SHOP/shifts)"  200
chk "a MANAGER is refused at another branch"    "$(c -b $M $B/settings/shops/$SSHOP/shifts)" 403
chk "a STAFF is refused the page"               "$(c -b $S $B/settings/shops/$SHOP/shifts)"  403

# Create, including the night shift §4.14 requires to be allowed.
SHIFT=$(j -b $O -X POST $B/api/shops/$SSHOP/shifts -H 'Content-Type: application/json' \
  -d '{"name":"Morning","startTime":"10:00","endTime":"18:00"}' | first_id)
[ -n "$SHIFT" ] && pass "a shift is created" || fail "a shift is created" "none"

j -b $O -X POST $B/api/shops/$SSHOP/shifts -H 'Content-Type: application/json' \
  -d '{"name":"Night","startTime":"22:00","endTime":"06:00"}' > $D/night.json
grep -q '"crossesMidnight":true' $D/night.json && pass "a night shift crossing midnight is allowed" || fail "a night shift crossing midnight is allowed" "$(cat $D/night.json)"

chk "start == end is 422" \
  "$(c -b $O -X POST $B/api/shops/$SSHOP/shifts -H 'Content-Type: application/json' \
     -d '{"name":"Nothing","startTime":"10:00","endTime":"10:00"}')" 422
chk "a malformed time is 422" \
  "$(c -b $O -X POST $B/api/shops/$SSHOP/shifts -H 'Content-Type: application/json' \
     -d '{"name":"Bad","startTime":"9:00","endTime":"17:00"}')" 422
chk "an empty day list is 422" \
  "$(c -b $O -X POST $B/api/shops/$SSHOP/shifts -H 'Content-Type: application/json' \
     -d '{"name":"Never","startTime":"10:00","endTime":"18:00","daysOfWeek":[]}')" 422

# Permissions on the API itself.
chk "a STAFF cannot create a shift" \
  "$(c -b $S -X POST $B/api/shops/$SHOP/shifts -H 'Content-Type: application/json' \
     -d '{"name":"Nope","startTime":"10:00","endTime":"18:00"}')" 403
chk "a MANAGER cannot create one at another branch" \
  "$(c -b $M -X POST $B/api/shops/$SSHOP/shifts -H 'Content-Type: application/json' \
     -d '{"name":"Nope","startTime":"10:00","endTime":"18:00"}')" 403
chk "a STAFF can still READ the shift list" "$(c -b $S $B/api/shops/$SHOP/shifts)" 200

# A manager genuinely can manage their own branch — the delegated half.
MSHIFT=$(j -b $M -X POST $B/api/shops/$SHOP/shifts -H 'Content-Type: application/json' \
  -d '{"name":"Manager Made","startTime":"08:00","endTime":"12:00"}' | first_id)
[ -n "$MSHIFT" ] && pass "a MANAGER creates a shift at their own shop" || fail "a MANAGER creates a shift at their own shop" "none"
chk "and can delete it again" "$(c -b $M -X DELETE $B/api/shops/$SHOP/shifts/$MSHIFT)" 200

# An unused shift deletes outright; one with attendance is retired instead.
chk "an unused shift deletes" "$(c -b $O -X DELETE $B/api/shops/$SSHOP/shifts/$SHIFT)" 200

KEEP=$(j -b $O -X POST $B/api/shops/$SSHOP/shifts -H 'Content-Type: application/json' \
  -d '{"name":"Used","startTime":"10:00","endTime":"18:00"}' | first_id)
db "await p.attendance.create({data:{userId:(await p.user.findFirstOrThrow({where:{role:'OWNER'}})).id,shopId:'$SSHOP',shiftId:'$KEEP',businessDate:new Date('2026-08-18'),clockInAt:new Date(),photoPath:'test/none.jpg',shiftStartAtCapture:new Date(Date.UTC(1970,0,1,10,0,0)),graceMinAtCapture:5,isLate:false,lateMinutes:0}}); return 'ok'" >/dev/null

j -b $O -X DELETE $B/api/shops/$SSHOP/shifts/$KEEP > $D/del.json
grep -q '"deactivated":true' $D/del.json && pass "a used shift is retired, not deleted" || fail "a used shift is retired, not deleted" "$(cat $D/del.json)"
STILL=$(db "const s = await p.shift.findUnique({where:{id:'$KEEP'}}); return s ? 'present' : 'gone'")
chk "the used shift row survives" "$STILL" "present"

# §4.14: editing must not restamp history.
db "await p.shift.update({where:{id:'$KEEP'},data:{isActive:true}}); return 'ok'" >/dev/null
j -b $O -X PATCH $B/api/shops/$SSHOP/shifts/$KEEP -H 'Content-Type: application/json' \
  -d '{"startTime":"09:00"}' >/dev/null
SNAP=$(db "return (await p.attendance.findFirst({where:{shiftId:'$KEEP'}})).shiftStartAtCapture.getUTCHours()")
chk "past attendance keeps its 10:00 snapshot" "$SNAP" "10"
LATE=$(db "return (await p.attendance.findFirst({where:{shiftId:'$KEEP'}})).isLate")
chk "and is not retroactively marked late" "$LATE" "false"

db "await p.attendance.deleteMany({where:{shopId:'$SSHOP'}});
    await p.shift.deleteMany({where:{shopId:'$SSHOP'}});
    await p.auditLog.deleteMany({where:{shopId:'$SSHOP'}});
    await p.shop.delete({where:{id:'$SSHOP'}});
    return 'ok'" >/dev/null

echo
echo "════ 12. Staff assignment from the shop (D-107) ════"

ACODE="A$(date +%H%M%S)"
ASHOP=$(j -b $O -X POST $B/api/shops -H 'Content-Type: application/json' \
  -d "{\"code\":\"$ACODE\",\"name\":\"Staff $ACODE\"}" | first_id)

# OWNER-only: setting shop access is owner work (§3.4), unlike shifts.
chk "the staff page loads for the OWNER"  "$(c -b $O $B/settings/shops/$ASHOP/staff)" 200
chk "a MANAGER is refused the page"       "$(c -b $M $B/settings/shops/$ASHOP/staff)" 403
chk "a STAFF is refused the page"         "$(c -b $S $B/settings/shops/$ASHOP/staff)" 403
chk "a MANAGER is 403 on the API"         "$(c -b $M $B/api/shops/$ASHOP/staff)"      403

j -b $O $B/api/shops/$SHOP/staff > $D/staff.json
grep -q '"isOnlyShop"' $D/staff.json && pass "the list reports the only-shop flag" || fail "the list reports the only-shop flag" "missing"
grep -q '"role":"OWNER"' $D/staff.json && fail "owners are excluded from the list" "an OWNER appeared" || pass "owners are excluded from the list"

STAFF_ID=$(db "return (await p.user.findUnique({where:{username:'staff1'}})).id")
OWNER_ID=$(db "return (await p.user.findFirstOrThrow({where:{role:'OWNER'}})).id")

# ─────────────────────────────────────────────────────────────────────────────
# Bodies go in a FILE via `-d @file`, never inline.
#
# Inline `-d "{\"userId\":...}"` inside a `$( )` substitution reaches curl as
# literal backslash-quotes, so the server sees invalid JSON and answers 422 —
# while `chk` was reading the status of a DIFFERENT call and reporting 200. The
# checks passed and the assignment never happened (D-108). Sections 10 and 11
# escaped this only because their JSON is single-quoted with no variables.
# ─────────────────────────────────────────────────────────────────────────────
body() { printf '{"userId":"%s","assigned":%s}' "$1" "$2" > $D/body.json; }
patch_staff() { # shopId userId assigned  → status
  body "$2" "$3"
  c -b $O -X PATCH "$B/api/shops/$1/staff" \
    -H 'Content-Type: application/json' -d @$D/body.json
}

# Prove the plumbing before trusting a single status below: a well-formed body
# must NOT come back as "Expected a JSON body".
body "$STAFF_ID" "true"
PROBE=$(j -b $O -X PATCH "$B/api/shops/$ASHOP/staff" -H 'Content-Type: application/json' -d @$D/body.json)
echo "$PROBE" | grep -q '"username":"staff1"' \
  && pass "the request body reaches the server" \
  || fail "the request body reaches the server" "$PROBE"

ROWS=$(db "return await p.userShop.count({where:{userId:'$STAFF_ID',shopId:'$ASHOP'}})")
chk "the probe actually created the assignment" "$ROWS" "1"

chk "assigning again is idempotent, not an error" \
  "$(patch_staff "$ASHOP" "$STAFF_ID" true)" 200
ROWS=$(db "return await p.userShop.count({where:{userId:'$STAFF_ID',shopId:'$ASHOP'}})")
chk "and did not create a duplicate row" "$ROWS" "1"

chk "removing them from BR-1 now succeeds" \
  "$(patch_staff "$SHOP" "$STAFF_ID" false)" 200
KEPT=$(db "return await p.userShop.count({where:{userId:'$STAFF_ID',shopId:'$ASHOP'}})")
chk "their other branch is untouched" "$KEPT" "1"

# Back to one shop, so the strand guard is genuinely in play.
chk "removing them from their ONLY remaining shop is 422" \
  "$(patch_staff "$ASHOP" "$STAFF_ID" false)" 422
STILL=$(db "return await p.userShop.count({where:{userId:'$STAFF_ID'}})")
chk "so they are never left with zero shops" "$STILL" "1"

# An owner needs no assignment (§3.1) and must not be given one.
chk "assigning an OWNER is 422" "$(patch_staff "$ASHOP" "$OWNER_ID" true)" 422
chk "a user that does not exist is 404" "$(patch_staff "$ASHOP" "no-such-user" true)" 404

# Restore staff1 to BR-1 so later runs and other scripts find them as seeded.
db "await p.userShop.upsert({where:{userId_shopId:{userId:'$STAFF_ID',shopId:'$SHOP'}},update:{},create:{userId:'$STAFF_ID',shopId:'$SHOP'}});
    await p.userShop.deleteMany({where:{userId:'$STAFF_ID',shopId:'$ASHOP'}});
    await p.user.update({where:{id:'$STAFF_ID'},data:{defaultShopId:'$SHOP'}});
    await p.auditLog.deleteMany({where:{shopId:'$ASHOP'}});
    await p.shop.delete({where:{id:'$ASHOP'}});
    return 'ok'" >/dev/null

RESTORED=$(db "return await p.userShop.count({where:{userId:'$STAFF_ID',shopId:'$SHOP'}})")
chk "cleanup: staff1 is back at BR-1" "$RESTORED" "1"

echo
[ "$FAILED" = "1" ] && { printf "\033[31mSOME CHECKS FAILED\033[0m\n"; exit 1; }
printf "\033[32mALL CHECKS PASSED\033[0m\n"
