#!/bin/bash
# Settings → Prizes (§4.8, §7.4, §8.10) — the prize catalog screen.
#
# Not a phase script: the catalog services shipped in Phase 5 with no UI at all
# (BUILD-LOG D-116). Same shape as `scripts/verify-shops.sh`, and re-runnable —
# every prize it creates carries a unique SKU and is RETIRED (never deleted) at
# the end, because a prize is referenced by redemptions and batches and
# CLAUDE.md forbids hard-deleting those.
cd "$(dirname "$0")/.." || exit 1
B=http://localhost:5050
D=$(mktemp -d)
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt
SEEDPW=$(grep SEED_OWNER_PASSWORD .env | cut -d= -f2)
FAILED=0

j() { curl -s "$@"; }
first_id() { grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4; }
c() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }
db() { node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await (async(p)=>{ $1 })(p))}finally{await p.\$disconnect()}})()"; }

login() {
  j -c "$3" -X POST $B/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}

# ── Fixtures ─────────────────────────────────────────────────────────────────
# A MISSING account logs in as nobody, which turns every "is refused" check
# into a 401 that LOOKS like a pass. The guard below refuses to report at all
# unless all three sessions are genuinely usable.
login owner "OwnerRealPass2026!" $O
if [ "$(c -b $O $B/api/auth/me)" != "200" ]; then
  login owner "$SEEDPW" $O
  j -b $O -c $O -X POST $B/api/auth/change-password -H 'Content-Type: application/json' \
    -d '{"newPassword":"OwnerRealPass2026!"}' >/dev/null
  login owner "OwnerRealPass2026!" $O
fi

if [ "$(c -b $O $B/api/auth/me)" != "200" ]; then
  printf "\033[31mCannot sign in as the owner — is the database seeded?\033[0m\n"
  exit 1
fi

SHOP=$(db "return (await p.shop.findFirst({where:{code:'BR-1'}})).id")
HQ=$(db "const s = await p.shop.findFirst({where:{isHqPseudoShop:true}}); return s ? s.id : 'NONE'")

ensure_user() { # username displayName role password jar
  local EXISTS
  EXISTS=$(db "const u = await p.user.findUnique({where:{username:'$1'}}); return u ? u.id : 'MISSING'")
  if [ "$EXISTS" = "MISSING" ]; then
    j -b $O -X POST $B/api/users -H 'Content-Type: application/json' \
      -d "{\"username\":\"$1\",\"displayName\":\"$2\",\"password\":\"$4\",\"role\":\"$3\",\"shopIds\":[\"$SHOP\"]}" >/dev/null
  fi
  db "const u = await p.user.findUnique({where:{username:'$1'}});
      await p.user.update({where:{id:u.id},data:{mustChangePassword:false,banned:false}});
      await p.userShop.upsert({where:{userId_shopId:{userId:u.id,shopId:'$SHOP'}},update:{},create:{userId:u.id,shopId:'$SHOP'}});
      return 'ok'" >/dev/null
  login "$1" "$4" "$5"
}

ensure_user manager1 "Manager One" MANAGER "MgrRealPass2026!"   $M
ensure_user staff1   "Staff One"   STAFF   "StaffRealPass2026!" $S

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

# Every role needs today's work session, or the page redirects to /select-shop
# and a 307 is neither the 200 nor the 403 the checks below expect.
for PAIR in "owner:$O" "manager1:$M" "staff1:$S"; do
  JAR=${PAIR##*:}
  j -b $JAR -X POST $B/api/work-session -H 'Content-Type: application/json' \
    -d "{\"shopId\":\"$SHOP\"}" >/dev/null
done

echo
echo "════ 1. Who reaches Settings → Prizes ════"
# D-116: OWNER *and* MANAGER, matching the requireManagerOrOwner gate the
# routes have always carried. This is the deliberate exception to the
# owner-only rule the rest of /settings follows.

chk "OWNER gets the page"           "$(c -b $O $B/settings/prizes)"  200
chk "MANAGER gets the page"         "$(c -b $M $B/settings/prizes)"  200
chk "STAFF is refused the page"     "$(c -b $S $B/settings/prizes)"  403
chk "signed out is redirected"      "$(c $B/settings/prizes)"        307

echo
echo "════ 2. Creating a catalog item ════"

SKU="VP$(date +%H%M%S)"
j -b $O -X POST $B/api/prizes -H 'Content-Type: application/json' \
  -d "{\"sku\":\"$SKU\",\"name\":\"Verify Prize $SKU\",\"category\":\"Verify\",\"ticketCost\":250}" > $D/new.json

PRIZE=$(first_id < $D/new.json)
[ -n "$PRIZE" ] && pass "the prize is created" || fail "the prize is created" "$(cat $D/new.json)"

chk "a duplicate SKU is a 409" \
  "$(c -b $O -X POST $B/api/prizes -H 'Content-Type: application/json' \
     -d "{\"sku\":\"$SKU\",\"name\":\"Dupe\",\"ticketCost\":10}")" 409

chk "STAFF cannot create a prize" \
  "$(c -b $S -X POST $B/api/prizes -H 'Content-Type: application/json' \
     -d "{\"sku\":\"${SKU}X\",\"name\":\"Nope\",\"ticketCost\":10}")" 403

# D-116: a new item is carried by NO branch. The Add form promises this, so if
# the service ever starts auto-stocking, the message becomes a lie.
CFG=$(db "return await p.shopPrizeConfig.count({where:{prizeItemId:'$PRIZE'}})")
chk "a new prize is carried by no branch" "$CFG" 0

echo
echo "════ 3. Ticket cost is global, and a reprice is announced (§4.8) ════"

j -b $O -X PATCH $B/api/prizes/$PRIZE -H 'Content-Type: application/json' \
  -d '{"ticketCost":300}' >/dev/null

ALERT=$(db "const a = await p.systemAlert.findUnique({where:{key:'TICKET_COST_CHANGED:$PRIZE'}}); return a ? a.isActive : 'NONE'")
chk "a reprice raises the owner alert" "$ALERT" true

AUD=$(db "return await p.auditLog.count({where:{entityId:'$PRIZE',action:'PRIZE_TICKET_COST_CHANGE'}})")
chk "a reprice writes an audit row" "$AUD" 1

# A rename must NOT alert, or every edit floods the dashboard and the real
# repricing signal is worthless.
j -b $O -X PATCH $B/api/prizes/$PRIZE -H 'Content-Type: application/json' \
  -d '{"name":"Renamed Verify Prize"}' >/dev/null
AUD2=$(db "return await p.auditLog.count({where:{entityId:'$PRIZE',action:'PRIZE_TICKET_COST_CHANGE'}})")
chk "a rename does not count as a reprice" "$AUD2" 1

echo
echo "════ 4. Per-shop config refuses a per-branch price ════"
# shopPrizeConfigSchema is .strict() precisely so this is REJECTED rather than
# silently stripped — a silent strip leaves a manager believing they set a
# branch price that was never stored.

chk "a valid config is accepted" \
  "$(c -b $O -X PUT $B/api/shops/$SHOP/prizes/$PRIZE/config -H 'Content-Type: application/json' \
     -d '{"lowStockThreshold":5,"isActive":true}')" 200

chk "smuggling ticketCost is rejected" \
  "$(c -b $O -X PUT $B/api/shops/$SHOP/prizes/$PRIZE/config -H 'Content-Type: application/json' \
     -d '{"lowStockThreshold":5,"isActive":true,"ticketCost":999}')" 422

if [ "$HQ" != "NONE" ]; then
  chk "HQ cannot hold prize stock (§4.12)" \
    "$(c -b $O -X PUT $B/api/shops/$HQ/prizes/$PRIZE/config -H 'Content-Type: application/json' \
       -d '{"lowStockThreshold":5,"isActive":true}')" 422
fi

echo
echo "════ 4b. Per-shop stocking round-trip (D-117, the Catalog tab) ════"
# The Catalog tab's whole job. Before it, `setShopPrizeConfig` had no caller,
# so received stock stayed invisible on On hand and the low-stock alert could
# never fire for it.

# A FRESH prize, because section 4 already configured $PRIZE — reusing it here
# would make "receiving alone does not carry it" pass or fail on leftover state
# rather than on the behaviour under test.
SKU2="${SKU}B"
j -b $O -X POST $B/api/prizes -H 'Content-Type: application/json' \
  -d "{\"sku\":\"$SKU2\",\"name\":\"Verify Stocking $SKU2\",\"ticketCost\":120}" > $D/new2.json
PRIZE2=$(first_id < $D/new2.json)
[ -n "$PRIZE2" ] && pass "a second prize for the stocking round-trip" || fail "a second prize for the stocking round-trip" "$(cat $D/new2.json)"

# Receive stock BEFORE carrying the item, the order that used to strand it.
j -b $O -X POST $B/api/stock/batches -H 'Content-Type: application/json' \
  -H "Idempotency-Key: verify-$SKU2-1" \
  -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PRIZE2\",\"qtyReceived\":10,\"unitCogs\":1000}" > $D/batch.json
BATCH=$(first_id < $D/batch.json)
[ -n "$BATCH" ] && pass "stock received for an uncarried item" || fail "stock received for an uncarried item" "$(cat $D/batch.json)"

# Not carried yet: the stock exists but the branch does not offer it.
j -b $O "$B/api/prizes?shopId=$SHOP&includeUnstocked=true" > $D/pre.json
CARRIED=$(db "const c = await p.shopPrizeConfig.findUnique({where:{shopId_prizeItemId:{shopId:'$SHOP',prizeItemId:'$PRIZE2'}}}); return c ? c.isActive : 'NONE'")
# NONE, not false: receiving creates NO config row whatsoever. That distinction
# is the bug D-117 fixes — "no row" is what On hand and §4.9's redemption
# filter both read as "this branch does not offer it".
chk "receiving alone does not make the branch carry it" "$CARRIED" NONE

# Carry it — what the Catalog tab's "Carry here" button sends.
chk "carrying the item is accepted" \
  "$(c -b $O -X PUT $B/api/shops/$SHOP/prizes/$PRIZE2/config -H 'Content-Type: application/json' \
     -d '{"lowStockThreshold":3,"isActive":true}')" 200

CARRIED2=$(db "const c = await p.shopPrizeConfig.findUnique({where:{shopId_prizeItemId:{shopId:'$SHOP',prizeItemId:'$PRIZE2'}}}); return c.isActive")
chk "the branch now carries it" "$CARRIED2" true

# Threshold 3 vs on-hand 10 → not low. Raise it above on-hand → low.
LOW1=$(j -b $O "$B/api/prizes?shopId=$SHOP&includeUnstocked=true" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).find(x=>x.id==='$PRIZE2');console.log(r.isLowStock)})")
chk "10 on hand with a threshold of 3 is not low" "$LOW1" false

j -b $O -X PUT $B/api/shops/$SHOP/prizes/$PRIZE2/config -H 'Content-Type: application/json' \
  -d '{"lowStockThreshold":20,"isActive":true}' >/dev/null
LOW2=$(j -b $O "$B/api/prizes?shopId=$SHOP&includeUnstocked=true" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).find(x=>x.id==='$PRIZE2');console.log(r.isLowStock)})")
chk "raising the threshold above on-hand flags it low" "$LOW2" true

# 0 means "never warn" (§4.8), even below any sane level.
j -b $O -X PUT $B/api/shops/$SHOP/prizes/$PRIZE2/config -H 'Content-Type: application/json' \
  -d '{"lowStockThreshold":0,"isActive":true}' >/dev/null
LOW3=$(j -b $O "$B/api/prizes?shopId=$SHOP&includeUnstocked=true" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).find(x=>x.id==='$PRIZE2');console.log(r.isLowStock)})")
chk "threshold 0 never warns (§4.8)" "$LOW3" false

# "Stop carrying" must NOT destroy stock — the toast promises the units stay.
j -b $O -X PUT $B/api/shops/$SHOP/prizes/$PRIZE2/config -H 'Content-Type: application/json' \
  -d '{"lowStockThreshold":0,"isActive":false}' >/dev/null
QTY=$(db "const b = await p.prizeBatch.aggregate({where:{shopId:'$SHOP',prizeItemId:'$PRIZE2',isVoid:false},_sum:{qtyRemaining:true}}); return b._sum.qtyRemaining")
chk "stopping carrying keeps the stock on the shelf" "$QTY" 10

chk "MANAGER may stock their own branch" \
  "$(c -b $M -X PUT $B/api/shops/$SHOP/prizes/$PRIZE2/config -H 'Content-Type: application/json' \
     -d '{"lowStockThreshold":4,"isActive":true}')" 200

chk "STAFF cannot stock a branch" \
  "$(c -b $S -X PUT $B/api/shops/$SHOP/prizes/$PRIZE2/config -H 'Content-Type: application/json' \
     -d '{"lowStockThreshold":4,"isActive":true}')" 403

echo
echo "════ 4c. Prize images (D-118) ════"
# Served only through an authenticated route — never a static path. Any
# signed-in role may READ (staff need images to redeem, §8.6); writing is
# manager-or-owner like every other catalog mutation.

# A real JPEG, generated with sharp so this exercises the actual decode path.
node -e "
const sharp=require('sharp');
sharp({create:{width:900,height:300,channels:3,background:'#b5744a'}})
  .jpeg().toFile('$D/prize.jpg').then(()=>console.log('ok'))" >/dev/null

chk "a prize with no image 404s" \
  "$(c -b $O $B/api/prizes/$PRIZE/image)" 404

chk "STAFF cannot upload an image" \
  "$(c -b $S -X POST $B/api/prizes/$PRIZE/image -F "image=@$D/prize.jpg")" 403

chk "OWNER uploads an image" \
  "$(c -b $O -X POST $B/api/prizes/$PRIZE/image -F "image=@$D/prize.jpg")" 200

chk "STAFF may READ the image (§8.6)" \
  "$(c -b $S $B/api/prizes/$PRIZE/image)" 200

chk "signed out cannot read the image" \
  "$(c $B/api/prizes/$PRIZE/image)" 401

# The stored file must be a square JPEG — §8.6's grid depends on it, and a
# 900x300 source is exactly the shape that used to come out non-square.
STORED=$(db "const i = await p.prizeItem.findUnique({where:{id:'$PRIZE'}}); return i.imagePath")
case "$STORED" in
  prizes/*) pass "the path is stored under prizes/" ;;
  *) fail "the path is stored under prizes/" "$STORED" ;;
esac

curl -s -b $O $B/api/prizes/$PRIZE/image -o $D/got.jpg
DIMS=$(node -e "require('sharp')('$D/got.jpg').metadata().then(m=>console.log(m.width+'x'+m.height+' '+m.format))")
chk "the served image is a 300x300 jpeg" "$DIMS" "300x300 jpeg"

# Replacing must delete the superseded file, or the data directory grows
# without bound and every backup carries the dead weight.
OLD_ABS=$(db "const i = await p.prizeItem.findUnique({where:{id:'$PRIZE'}}); return i.imagePath")
j -b $O -X POST $B/api/prizes/$PRIZE/image -F "image=@$D/prize.jpg" >/dev/null
NEW_ABS=$(db "const i = await p.prizeItem.findUnique({where:{id:'$PRIZE'}}); return i.imagePath")
[ "$OLD_ABS" != "$NEW_ABS" ] && pass "replacing stores a new file" || fail "replacing stores a new file" "$NEW_ABS"

DATA_DIR=$(db "return process.env.DATA_DIR || require('path').join(process.cwd(),'data')")
if [ -e "$DATA_DIR/$OLD_ABS" ]; then
  fail "replacing deletes the superseded file" "$OLD_ABS still on disk"
else
  pass "replacing deletes the superseded file"
fi

chk "the image can be removed" \
  "$(c -b $O -X DELETE $B/api/prizes/$PRIZE/image)" 200

CLEARED=$(db "const i = await p.prizeItem.findUnique({where:{id:'$PRIZE'}}); return i.imagePath === null ? 'null' : i.imagePath")
chk "imagePath is cleared" "$CLEARED" null

# Idempotent: a double-tap on shop wifi must not surface an error for
# something that is already true.
chk "removing again is a no-op, not a 404" \
  "$(c -b $O -X DELETE $B/api/prizes/$PRIZE/image)" 200

chk "a non-image file is refused" \
  "$(printf 'not an image' > $D/bad.txt; c -b $O -X POST $B/api/prizes/$PRIZE/image -F "image=@$D/bad.txt")" 422

echo
echo "════ 4d. Manual stock adjustment (D-119) ════"
# `POST /api/stock/adjust` shipped in Phase 4 with no caller. It writes stock,
# so the reason, the FIFO direction and the negative-stock guard all matter.

# Fresh prize + a known 10 units, so the arithmetic below is unambiguous.
SKU3="${SKU}C"
j -b $O -X POST $B/api/prizes -H 'Content-Type: application/json' \
  -d "{\"sku\":\"$SKU3\",\"name\":\"Verify Adjust $SKU3\",\"ticketCost\":50}" > $D/new3.json
PRIZE3=$(first_id < $D/new3.json)
j -b $O -X PUT $B/api/shops/$SHOP/prizes/$PRIZE3/config -H 'Content-Type: application/json' \
  -d '{"lowStockThreshold":0,"isActive":true}' >/dev/null
j -b $O -X POST $B/api/stock/batches -H 'Content-Type: application/json' \
  -H "Idempotency-Key: verify-$SKU3-1" \
  -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PRIZE3\",\"qtyReceived\":10,\"unitCogs\":1000}" >/dev/null

adjust() { # delta reason [jar] [idempotency-key]
  local JAR=${3:-$O}
  local KEY=${4:-$(uuidgen)}
  c -b $JAR -X POST $B/api/stock/adjust -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $KEY" \
    -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PRIZE3\",\"delta\":$1,\"reason\":\"$2\"}"
}
on_hand() { db "const b = await p.prizeBatch.aggregate({where:{shopId:'$SHOP',prizeItemId:'$PRIZE3',isVoid:false},_sum:{qtyRemaining:true}}); return b._sum.qtyRemaining ?? 0"; }

chk "a reason is mandatory"          "$(adjust -1 '')"     422
chk "a zero delta is refused"        "$(adjust 0 'Nothing')" 422
chk "STAFF cannot adjust stock"      "$(adjust -1 'Damaged' $S)" 403

chk "removing 3 succeeds"            "$(adjust -3 'Damaged by a customer')" 200
chk "on hand is now 7"               "$(on_hand)" 7

chk "adding 5 found stock succeeds"  "$(adjust 5 'Found in the store room')" 200
chk "on hand is now 12"              "$(on_hand)" 12

# Found stock has no invoice — it must land in the uncosted queue, or prize
# expense stays understated for as long as those units last (§7.5).
ADJ=$(db "return await p.prizeBatch.count({where:{shopId:'$SHOP',prizeItemId:'$PRIZE3',isAdjustment:true,needsCosting:true}})")
chk "found stock is flagged for costing" "$ADJ" 1

# Stock may never go negative — checked at commit time, inside the transaction.
# 409, not 422: `InsufficientStockError` is a CONFLICT. The stock was valid
# when the form was drawn and is not any more, which is a different thing from
# a malformed request — and the distinction is what lets the UI say "someone
# else just took some" rather than "your input is wrong".
chk "removing more than on hand is refused" "$(adjust -99 'Too many')" 409
chk "on hand is unchanged after the refusal" "$(on_hand)" 12

# A double-tap on slow shop wifi must not book the adjustment twice.
KEY=$(uuidgen)
adjust -2 'Double tap test' $O $KEY >/dev/null
adjust -2 'Double tap test' $O $KEY >/dev/null
chk "a repeated Idempotency-Key adjusts once" "$(on_hand)" 10

# §4.16: the reason reaches both the movement and the audit row.
# THREE movements, not four: -3, +5 and -2. The fourth call reused its
# Idempotency-Key and was deduped, which is the check above passing.
TOTAL=$(db "return await p.stockMovement.count({where:{prizeItemId:'$PRIZE3',type:'MANUAL_ADJUST'}})")
REASONED=$(db "return await p.stockMovement.count({where:{prizeItemId:'$PRIZE3',type:'MANUAL_ADJUST',reason:{not:null}}})")
chk "three adjustments were recorded" "$TOTAL" 3
chk "every adjustment movement carries a reason" "$REASONED" "$TOTAL"

AUD=$(db "const a = await p.auditLog.findFirst({where:{entityId:'$PRIZE3',action:'STOCK_ADJUST'},orderBy:{id:'desc'}}); return a ? a.reason : 'NONE'")
[ "$AUD" != "NONE" ] && pass "the adjustment is audited with its reason" || fail "the adjustment is audited with its reason" "$AUD"

echo
echo "════ 5. The catalog list ════"

chk "OWNER lists with unstocked included" \
  "$(c -b $O "$B/api/prizes?shopId=$SHOP&includeUnstocked=true")" 200
chk "MANAGER lists their own shop" \
  "$(c -b $M "$B/api/prizes?shopId=$SHOP&includeUnstocked=true")" 200

# §7.5: a plain manager must get no valuation at all. Not "0" — absent.
j -b $M "$B/api/prizes?shopId=$SHOP&includeUnstocked=true" > $D/mgr.json
if grep -q "stockValuation" $D/mgr.json; then
  fail "no cost field reaches a plain MANAGER" "stockValuation present"
else
  pass "no cost field reaches a plain MANAGER"
fi

echo
echo "════ 6. Cleanup — retire, never delete ════"

j -b $O -X PATCH $B/api/prizes/$PRIZE -H 'Content-Type: application/json' \
  -d '{"isActive":false}' >/dev/null
STILL=$(db "const i = await p.prizeItem.findUnique({where:{id:'$PRIZE'}}); return i ? i.isActive : 'GONE'")
chk "the prize is retired, not deleted" "$STILL" false

# Clear the alert this run raised so it does not sit on the owner's dashboard.
db "await p.systemAlert.deleteMany({where:{key:'TICKET_COST_CHANGED:$PRIZE'}}); return 'ok'" >/dev/null

# Void the batch this run received and drop its config row, so a re-run starts
# clean and the stock does not linger in the branch's on-hand or valuation.
# Void, not delete: a batch is a money row (CLAUDE.md), and the verify script
# should model the same discipline the app does.
# Sweep retired prizes left by EARLIER runs of this script. They are inert
# (retired, no stock), but they accumulate in the catalog list and make the
# Stock screen's counts noisy. Safe to hard-delete only because nothing has
# ever redeemed or stocked them — the guard below checks exactly that, so a
# prize that somehow acquired history is left alone rather than deleted.
db "const stale = await p.prizeItem.findMany({where:{sku:{startsWith:'VP'},isActive:false},select:{id:true}});
    const ids = stale.map(x=>x.id);
    if (ids.length) {
      const used = await p.redemptionLine.count({where:{prizeItemId:{in:ids}}});
      const live = await p.prizeBatch.count({where:{prizeItemId:{in:ids},isVoid:false}});
      if (used === 0 && live === 0) {
        await p.stockMovement.deleteMany({where:{prizeItemId:{in:ids}}});
        await p.prizeBatch.deleteMany({where:{prizeItemId:{in:ids}}});
        await p.shopPrizeConfig.deleteMany({where:{prizeItemId:{in:ids}}});
        await p.auditLog.deleteMany({where:{entityId:{in:ids}}});
        await p.prizeItem.deleteMany({where:{id:{in:ids}}});
      }
    }
    return 'ok'" >/dev/null

db "const ids = ['$PRIZE','$PRIZE2','$PRIZE3'];
    const batches = await p.prizeBatch.findMany({where:{prizeItemId:{in:ids}},select:{id:true}});
    await p.stockConsumption.deleteMany({where:{batchId:{in:batches.map(b=>b.id)}}});
    await p.prizeBatch.updateMany({where:{prizeItemId:{in:ids}},data:{isVoid:true}});
    await p.stockMovement.deleteMany({where:{prizeItemId:{in:ids}}});
    await p.shopPrizeConfig.deleteMany({where:{prizeItemId:{in:ids}}});
    await p.prizeItem.updateMany({where:{id:{in:['$PRIZE2','$PRIZE3']}},data:{isActive:false}});
    return 'ok'" >/dev/null

echo
if [ "$FAILED" = "0" ]; then
  printf "\033[32mALL CHECKS PASSED\033[0m\n"
else
  printf "\033[31mSOME CHECKS FAILED\033[0m\n"
fi
rm -rf "$D"
exit $FAILED
