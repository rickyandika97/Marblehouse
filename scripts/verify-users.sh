#!/bin/bash
# Settings → Users — the edit screen (§7.9, §5.4; BUILD-LOG D-109).
#
# Separate from verify-shops.sh because it touches ACCOUNTS, not branches, and
# a failure part-way through must not leave a login broken. Everything it
# creates is prefixed `zzv-` and removed at the end; it never edits the seed's
# owner / manager1 / staff1 beyond reading them.
#
# Bodies with variables go in a FILE (`-d @`), never inline — see D-108.
cd "$(dirname "$0")/.." || exit 1
B=http://localhost:5050
D=$(mktemp -d)
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt
SEEDPW=$(grep SEED_OWNER_PASSWORD .env | cut -d= -f2)
FAILED=0

j() { curl -s "$@"; }
c() { curl -s -o /dev/null -w "%{http_code}" "$@"; }
first_id() { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }
db() { node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await (async(p)=>{ $1 })(p))}finally{await p.\$disconnect()}})()"; }
login() {
  j -c "$3" -X POST $B/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}

login owner "OwnerRealPass2026!" $O
[ "$(c -b $O $B/api/auth/me)" = "200" ] || login owner "$SEEDPW" $O
if [ "$(c -b $O $B/api/auth/me)" != "200" ]; then
  printf "\033[31mCannot sign in as the owner — run verify-shops.sh first.\033[0m\n"; exit 1
fi
login manager1 "MgrRealPass2026!"   $M
login staff1   "StaffRealPass2026!" $S

SHOP=$(db "return (await p.shop.findFirst({where:{code:'BR-1'}})).id")
SHOP2=$(db "const s = await p.shop.findFirst({where:{code:{not:'BR-1'},isActive:true,isHqPseudoShop:false}}); return s ? s.id : 'NONE'")

# A throwaway account to edit. Never the seed's.
U=zzv-$(date +%H%M%S)
printf '{"username":"%s","displayName":"Verify Target","password":"TempVerify2026!","role":"STAFF","shopIds":["%s"]}' "$U" "$SHOP" > $D/new.json
TARGET=$(j -b $O -X POST $B/api/users -H 'Content-Type: application/json' -d @$D/new.json | first_id)
[ -n "$TARGET" ] && pass "fixture: a throwaway account exists" || { fail "fixture: a throwaway account exists" "none"; exit 1; }

# ─────────────────────────────────────────────────────────────────────────────
# Read a JSON body from STDIN, never from an argument.
#
# `patch_user '{"role":"MANAGER"}'` looks safe and is not: the shell performs
# BRACE EXPANSION on an unquoted-looking `{...}` before the function ever runs,
# and the outer braces vanish. The server then receives `"role":"MANAGER"` —
# invalid JSON — while the status check happily read 200 from a well-formed
# earlier call. Same family of false pass as D-108, different mechanism.
#
# A quoted heredoc (`<<'JSON'`) is literal: no expansion, no escaping to lose.
# ─────────────────────────────────────────────────────────────────────────────
patch_user() { # body on stdin → status
  cat > $D/body.json
  c -b $O -X PATCH "$B/api/users/$TARGET" -H 'Content-Type: application/json' -d @$D/body.json
}
post_reset() { # body on stdin → status
  cat > $D/body.json
  c -b $O -X POST "$B/api/users/$TARGET/reset-password" \
    -H 'Content-Type: application/json' -d @$D/body.json
}

echo
echo "════ 1. Only the OWNER reaches the screen ════"
chk "OWNER gets the page"          "$(c -b $O $B/settings/users)" 200
chk "MANAGER is refused"           "$(c -b $M $B/settings/users)" 403
chk "STAFF is refused"             "$(c -b $S $B/settings/users)" 403
cat > $D/body.json <<'JSON'
{"displayName":"Hijacked"}
JSON
chk "MANAGER is 403 on PATCH"      "$(c -b $M -X PATCH $B/api/users/$TARGET -H 'Content-Type: application/json' -d @$D/body.json)" 403
chk "STAFF is 403 on reset"        "$(c -b $S -X POST $B/api/users/$TARGET/reset-password -H 'Content-Type: application/json' -d @$D/body.json)" 403

echo
echo "════ 2. Editing an account ════"
chk "rename succeeds" "$(patch_user <<'JSON'
{"displayName":"Renamed Person"}
JSON
)" 200
NAME=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).displayName")
chk "the new name is stored"       "$NAME" "Renamed Person"
MIRROR=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).name")
chk "and mirrored into Better Auth's name" "$MIRROR" "Renamed Person"

USERNAME_BEFORE=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).username")
chk "sending a username changes nothing" "$(patch_user <<'JSON'
{"username":"hacked","displayName":"Renamed Person"}
JSON
)" 200
USERNAME_AFTER=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).username")
chk "the username is immutable"    "$USERNAME_AFTER" "$USERNAME_BEFORE"

chk "promoting to MANAGER succeeds" "$(patch_user <<JSON
{"role":"MANAGER","canEnterCost":true,"shopIds":["$SHOP"]}
JSON
)" 200
COST=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).canEnterCost")
chk "Purchasing is now on"         "$COST" "true"

chk "demoting to STAFF succeeds" "$(patch_user <<JSON
{"role":"STAFF","shopIds":["$SHOP"]}
JSON
)" 200
COST=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).canEnterCost")
chk "Purchasing is stripped on demotion (§7.5)" "$COST" "false"

echo
echo "════ 3. Shop assignment through the form ════"
if [ "$SHOP2" != "NONE" ]; then
  chk "assigning two shops succeeds" "$(patch_user <<JSON
{"shopIds":["$SHOP","$SHOP2"]}
JSON
)" 200
  N=$(db "return await p.userShop.count({where:{userId:'$TARGET'}})")
  chk "both are stored" "$N" "2"
  chk "back to one succeeds" "$(patch_user <<JSON
{"shopIds":["$SHOP"],"defaultShopId":"$SHOP"}
JSON
)" 200
else
  printf "  \033[33m•\033[0m %s\n" "two-shop checks SKIPPED — only one active branch exists"
fi
chk "an empty shop list is 422" "$(patch_user <<'JSON'
{"shopIds":[]}
JSON
)" 422
N=$(db "return await p.userShop.count({where:{userId:'$TARGET'}})")
chk "so they still have a shop"    "$N" "1"

echo
echo "════ 4. Deactivating ════"
chk "deactivation succeeds" "$(patch_user <<'JSON'
{"isActive":false,"deactivationReason":"Left the company"}
JSON
)" 200
BANNED=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).banned")
chk "the account is banned"        "$BANNED" "true"
REASON=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).banReason")
chk "the reason is recorded"       "$REASON" "Left the company"
SESSIONS=$(db "return await p.session.count({where:{userId:'$TARGET'}})")
chk "their sessions are destroyed" "$SESSIONS" "0"
chk "a deactivated account cannot sign in" \
  "$(c -X POST $B/api/auth/login -H 'Content-Type: application/json' -d @$D/new.json)" 401
STILL=$(db "const u = await p.user.findUnique({where:{id:'$TARGET'}}); return u ? 'present' : 'gone'")
chk "the row survives — never a delete" "$STILL" "present"
chk "reactivation succeeds" "$(patch_user <<'JSON'
{"isActive":true}
JSON
)" 200
REASON=$(db "const r = (await p.user.findUnique({where:{id:'$TARGET'}})).banReason; return r === null ? 'null' : r")
chk "and clears the reason"        "$REASON" "null"

echo
echo "════ 5. The owner cannot lock themselves out ════"
#
# The seed database usually has exactly ONE owner, so a bare "deactivate
# yourself" 422 proves nothing about the SELF guard — the last-active-owner
# guard answers first and the check passes even with the self guard deleted
# (observed while writing this: removing it left every check green).
#
# So create a SECOND owner first. With two owners the last-owner guard cannot
# fire, and a 422 can only be the self guard. The second owner is removed at
# the end of this section.
OWNER_ID=$(db "return (await p.user.findFirstOrThrow({where:{username:'owner'}})).id")

SPARE=zzv-spare-$(date +%H%M%S)
cat > $D/spare.json <<JSON
{"username":"$SPARE","displayName":"Spare Owner","password":"SpareOwner2026!","role":"OWNER","shopIds":[]}
JSON
SPARE_ID=$(j -b $O -X POST $B/api/users -H 'Content-Type: application/json' -d @$D/spare.json | first_id)
[ -n "$SPARE_ID" ] && pass "a second owner exists, so the last-owner guard cannot fire" \
  || fail "a second owner exists, so the last-owner guard cannot fire" "none"

self_patch() { # body on stdin → status
  cat > $D/self.json
  c -b $O -X PATCH "$B/api/users/$OWNER_ID" -H 'Content-Type: application/json' -d @$D/self.json
}

chk "deactivating yourself is 422" "$(self_patch <<'JSON'
{"isActive":false}
JSON
)" 422
chk "changing your own role is 422" "$(self_patch <<'JSON'
{"role":"STAFF"}
JSON
)" 422

# And the message must be the SELF one, not the last-owner one — otherwise the
# check above is passing for the wrong reason.
cat > $D/self.json <<'JSON'
{"isActive":false}
JSON
SELFMSG=$(j -b $O -X PATCH "$B/api/users/$OWNER_ID" -H 'Content-Type: application/json' -d @$D/self.json)
echo "$SELFMSG" | grep -q "your own account" \
  && pass "and it is the SELF guard that refused" \
  || fail "and it is the SELF guard that refused" "$SELFMSG"

OWNER_OK=$(db "return (await p.user.findUnique({where:{id:'$OWNER_ID'}})).banned")
chk "the owner is untouched"       "$OWNER_OK" "false"
chk "and can still sign in"        "$(c -b $O $B/api/auth/me)" 200

# Remove the spare owner so the database is left as it was found.
db "await p.session.deleteMany({where:{userId:'$SPARE_ID'}});
    await p.account.deleteMany({where:{userId:'$SPARE_ID'}});
    await p.auditLog.deleteMany({where:{OR:[{userId:'$SPARE_ID'},{entityId:'$SPARE_ID'}]}});
    await p.userShop.deleteMany({where:{userId:'$SPARE_ID'}});
    await p.user.delete({where:{id:'$SPARE_ID'}});
    return 'ok'" >/dev/null
OWNERS=$(db "return await p.user.count({where:{role:'OWNER',banned:{not:true}}})")
chk "cleanup: exactly one owner remains" "$OWNERS" "1"

echo "════ 6. Resetting a password ════"
chk "a weak password is 422" "$(post_reset <<'JSON'
{"newPassword":"short"}
JSON
)" 422
chk "a common password is 422" "$(post_reset <<'JSON'
{"newPassword":"password"}
JSON
)" 422
chk "a strong password is accepted" "$(post_reset <<'JSON'
{"newPassword":"FreshVerify2026!"}
JSON
)" 200
MUST=$(db "return (await p.user.findUnique({where:{id:'$TARGET'}})).mustChangePassword")
chk "a change is forced on next login" "$MUST" "true"

# The reset really works, and really forces a change.
printf '{"username":"%s","password":"FreshVerify2026!"}' "$U" > $D/li.json
j -c $D/t.txt -X POST $B/api/auth/login -H 'Content-Type: application/json' -d @$D/li.json > $D/li.out
grep -q '"mustChangePassword":true' $D/li.out && pass "they can sign in and are told to change it" || fail "they can sign in and are told to change it" "$(head -c 160 $D/li.out)"

AUDIT=$(db "return JSON.stringify(await p.auditLog.findMany({where:{entityId:'$TARGET',action:'RESET_PASSWORD'}}))")
echo "$AUDIT" | grep -q "FreshVerify2026" && fail "the password is never audit-logged" "it appears in the log" || pass "the password is never audit-logged"

echo
echo "════ 7. Cleanup ════"
db "await p.session.deleteMany({where:{userId:'$TARGET'}});
    await p.account.deleteMany({where:{userId:'$TARGET'}});
    await p.auditLog.deleteMany({where:{OR:[{userId:'$TARGET'},{entityId:'$TARGET'}]}});
    await p.userShop.deleteMany({where:{userId:'$TARGET'}});
    await p.user.delete({where:{id:'$TARGET'}});
    return 'ok'" >/dev/null
GONE=$(db "const u = await p.user.findUnique({where:{id:'$TARGET'}}); return u ? 'still there' : 'removed'")
chk "the throwaway account is removed" "$GONE" "removed"
SEED_OK=$(db "return (await p.user.findFirstOrThrow({where:{username:'owner'}})).banned")
chk "the seed owner is still active"   "$SEED_OK" "false"

echo
echo "════ 8. Staff never land on a page they cannot open (D-113) ════"
#
# The unit test pins `landingPathFor`. This pins what actually broke: a BUTTON
# hardcoded to /dashboard, which the pure function cannot see.
#
# IMPORTANT: the buttons only exist on the post-clock-in screens. A fresh
# clock-in page renders the CAMERA step, whose markup contains no button at
# all — so a naive "is there a /dashboard link?" check passes even with the bug
# fully present (observed while writing this). An attendance row must exist
# first, which renders the "already clocked in" branch and its Back button.

login staff1 "StaffRealPass2026!" $S
BR1=$(db "return (await p.shop.findFirst({where:{code:'BR-1'}})).id")
cat > $D/ws.json <<JSON
{"shopId":"$BR1"}
JSON
j -b $S -X POST $B/api/work-session -H 'Content-Type: application/json' -d @$D/ws.json >/dev/null

chk "STAFF is refused /dashboard outright" "$(c -b $S $B/dashboard)" 403

STAFF_ID=$(db "return (await p.user.findFirstOrThrow({where:{username:'staff1'}})).id")
db "const shift = await p.shift.findFirst({where:{shopId:'$BR1'}});
    await p.attendance.deleteMany({where:{userId:'$STAFF_ID',businessDate:new Date(new Date().toISOString().slice(0,10))}});
    await p.attendance.create({data:{userId:'$STAFF_ID',shopId:'$BR1',shiftId:shift?shift.id:null,businessDate:new Date(new Date().toISOString().slice(0,10)),clockInAt:new Date(),photoPath:'test/none.jpg',status:'PRESENT',isLate:false,lateMinutes:0}});
    return 'ok'" >/dev/null

CLOCKIN=$(j -b $S $B/attendance/clock-in)

# Prove the BUTTON is on the page before judging where it points — otherwise
# this whole section is asserting things about markup that is not there.
echo "$CLOCKIN" | grep -q "Only one clock-in is recorded per day" \
  && pass "the post-clock-in screen is what is being checked" \
  || fail "the post-clock-in screen is what is being checked" "the camera step rendered instead"

echo "$CLOCKIN" | grep -q 'href="/dashboard"' \
  && fail "the clock-in screen has no /dashboard link for STAFF" "found one" \
  || pass "the clock-in screen has no /dashboard link for STAFF"

# Two /sale hrefs: the nav tab, and the Back button. One means the button is
# missing or pointing elsewhere.
SALES=$(echo "$CLOCKIN" | grep -o 'href="/sale"' | wc -l | tr -d ' ')
[ "$SALES" -ge 2 ] && pass "the Back button points at /sale" \
  || fail "the Back button points at /sale" "only $SALES /sale link(s) — the button is missing"

db "await p.attendance.deleteMany({where:{userId:'$STAFF_ID',businessDate:new Date(new Date().toISOString().slice(0,10))}}); return 'ok'" >/dev/null

# The owner keeps their dashboard button — the fix must not flatten everyone.
OWNER_ID=$(db "return (await p.user.findFirstOrThrow({where:{username:'owner'}})).id")
db "const shift = await p.shift.findFirst({where:{shopId:'$BR1'}});
    await p.attendance.deleteMany({where:{userId:'$OWNER_ID',businessDate:new Date(new Date().toISOString().slice(0,10))}});
    await p.attendance.create({data:{userId:'$OWNER_ID',shopId:'$BR1',shiftId:shift?shift.id:null,businessDate:new Date(new Date().toISOString().slice(0,10)),clockInAt:new Date(),photoPath:'test/none.jpg',status:'PRESENT',isLate:false,lateMinutes:0}});
    return 'ok'" >/dev/null
cat > $D/ws.json <<JSON
{"shopId":"$BR1"}
JSON
j -b $O -X POST $B/api/work-session -H 'Content-Type: application/json' -d @$D/ws.json >/dev/null
j -b $O $B/attendance/clock-in | grep -q 'href="/dashboard"' \
  && pass "an OWNER still gets the dashboard button" \
  || fail "an OWNER still gets the dashboard button" "missing"
db "await p.attendance.deleteMany({where:{userId:'$OWNER_ID',businessDate:new Date(new Date().toISOString().slice(0,10))}}); return 'ok'" >/dev/null

echo
[ "$FAILED" = "1" ] && { printf "\033[31mSOME CHECKS FAILED\033[0m\n"; exit 1; }
printf "\033[32mALL CHECKS PASSED\033[0m\n"
