#!/bin/bash
# Phase 5 acceptance: transfers and opname (PRD §4.10, §4.11, §16).
#
# Needs the dev server on localhost:5050 and the Phase 1 test accounts. Writes
# uniquely named test prizes and transfers to the dev database.
#
# §16 accepts Phase 5 on two things:
#
#   "a transfer round trip conserves both quantity and total cost, and an
#    opname loss appears as shrinkage rather than prize expense"
#
# Both are asserted below against real HTTP responses and the real database.
# The FIFO arithmetic underneath is proven by `npm test`; what only this script
# can prove is that the API surface enforces it for actual roles.
set -u
cd /Users/ricky/redlight || exit 1

B=http://localhost:5050
D=$(mktemp -d)
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt
FAILED=0

j() { curl -sS "$@"; }
c() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
# An empty actual value almost always means the query or curl errored rather
# than genuinely returning "". Treat it as a failure: a check that passes
# because it crashed is worse than no check at all. (Found the hard way — a
# malformed inline query made this script report a false PASS.)
chk() {
  if [ -z "$2" ] && [ -n "$3" ]; then fail "$1" "<empty — query failed?>"; return; fi
  [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"
}
login() {
  j -c "$3" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}
key() { uuidgen; }
q() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1 ?? ''"; }
db() { node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await (async(p)=>{ $1 })(p))}finally{await p.\$disconnect()}})()"; }

SUFFIX=$(date +%s | tail -c 7)

printf "════ Phase 5 setup ════\n"
login owner OwnerRealPass2026! "$O"
login manager1 MgrRealPass2026! "$M"
login staff1 StaffRealPass2026! "$S"

SHOP=$(db "return (await p.shop.findFirst({where:{code:'BR-1'}})).id")
SHOP2=$(db "return (await p.shop.findFirst({where:{code:'BR-2'}})).id")
for JAR in "$O" "$M" "$S"; do
  j -b "$JAR" -X POST "$B/api/work-session" -H 'Content-Type: application/json' \
    -d "{\"shopId\":\"$SHOP\"}" >/dev/null
done

# A prize with two batches at DIFFERENT costs, so a round trip that averaged
# them would show up as a changed total rather than passing silently.
PRIZE=$(j -b "$O" -X POST "$B/api/prizes" -H 'Content-Type: application/json' \
  -d "{\"name\":\"P5 Transfer Bear $SUFFIX\",\"sku\":\"P5-$SUFFIX\",\"ticketCost\":100}" | q ".id")
for SPEC in "6 1000" "6 3000"; do
  set -- $SPEC
  j -b "$O" -X POST "$B/api/stock/batches" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(key)" \
    -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PRIZE\",\"qtyReceived\":$1,\"unitCogs\":$2,\"supplier\":\"P5\"}" >/dev/null
done
printf "  prize=%s  BR-1=%s  BR-2=%s\n" "${PRIZE:0:8}" "${SHOP:0:8}" "${SHOP2:0:8}"

onhand() { db "const a=await p.prizeBatch.aggregate({where:{shopId:'$1',prizeItemId:'$PRIZE',isVoid:false},_sum:{qtyRemaining:true}});return a._sum.qtyRemaining??0"; }
value() { db "
  const bs=await p.prizeBatch.findMany({where:{shopId:'$1',prizeItemId:'$PRIZE',isVoid:false},select:{qtyRemaining:true,unitCogs:true}});
  return bs.reduce((s,b)=>s+b.qtyRemaining*Number(b.unitCogs),0);
"; }

printf "\n════ §4.10 dispatch ════\n"
QTY_BEFORE=$(( $(onhand "$SHOP") + $(onhand "$SHOP2") ))
VAL_BEFORE=$(( $(value "$SHOP") + $(value "$SHOP2") ))

# 8 units spans both batches: all 6 at 1000, then 2 at 3000.
T1=$(j -b "$O" -X POST "$B/api/transfers" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$SHOP2\",\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"qty\":8}]}")
TID=$(echo "$T1" | q ".id")
chk "dispatch returns IN_TRANSIT" "$(echo "$T1" | q ".status")" "IN_TRANSIT"
chk "source is drawn down immediately" "$(onhand "$SHOP")" "4"
chk "in-transit stock is in NEITHER branch's on-hand" "$(onhand "$SHOP2")" "0"

chk "dispatch beyond stock is refused" \
  "$(c -b "$O" -X POST "$B/api/transfers" -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
     -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$SHOP2\",\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"qty\":9999}]}")" "409"
chk "a transfer to the same shop is refused" \
  "$(c -b "$O" -X POST "$B/api/transfers" -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
     -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$SHOP\",\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"qty\":1}]}")" "422"

printf "\n════ §16: round trip conserves quantity AND cost ════\n"
chk "receive succeeds" \
  "$(c -b "$O" -X POST "$B/api/transfers/$TID/receive" -H "Idempotency-Key: $(key)")" "200"

QTY_AFTER=$(( $(onhand "$SHOP") + $(onhand "$SHOP2") ))
VAL_AFTER=$(( $(value "$SHOP") + $(value "$SHOP2") ))
chk "total quantity across both branches is unchanged" "$QTY_AFTER" "$QTY_BEFORE"
chk "total cost across both branches is unchanged" "$VAL_AFTER" "$VAL_BEFORE"

# The destination must hold the SPLIT, not one averaged batch.
DST_BATCHES=$(db "return p.prizeBatch.count({where:{shopId:'$SHOP2',prizeItemId:'$PRIZE'}})")
chk "destination holds one batch per source batch consumed" "$DST_BATCHES" "2"
DST_COSTS=$(db "
  const bs = await p.prizeBatch.findMany({where:{shopId:'$SHOP2',prizeItemId:'$PRIZE'},orderBy:{receivedAt:'asc'},select:{qtyRemaining:true,unitCogs:true}});
  return bs.map(b => b.qtyRemaining + '@' + Number(b.unitCogs)).join(',');
")
chk "destination preserves the original unit costs" "$DST_COSTS" "6@1000,2@3000"

# §4.10's load-bearing rule: FIFO sorts on receivedAt, so a transferred batch
# must keep its ORIGINAL date or the destination consumes in the wrong order.
KEPT_DATES=$(db "
  const src = await p.prizeBatch.findMany({where:{shopId:'$SHOP',prizeItemId:'$PRIZE'},select:{receivedAt:true}});
  const dst = await p.prizeBatch.findMany({where:{shopId:'$SHOP2',prizeItemId:'$PRIZE'},select:{receivedAt:true}});
  const iso = a => a.map(x => x.receivedAt.toISOString());
  const srcDates = iso(src);
  return iso(dst).every(d => srcDates.includes(d)) ? 'yes' : 'no';
")
chk "transferred batches keep their ORIGINAL receivedAt" "$KEPT_DATES" "yes"

chk "a second receive is refused" \
  "$(c -b "$O" -X POST "$B/api/transfers/$TID/receive" -H "Idempotency-Key: $(key)")" "409"

printf "\n════ §4.10 cancel (D-38: reason mandatory) ════\n"
T2=$(j -b "$O" -X POST "$B/api/transfers" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$SHOP2\",\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"qty\":2}]}")
TID2=$(echo "$T2" | q ".id")
BEFORE_CANCEL=$(onhand "$SHOP")

chk "cancel without a reason is refused" \
  "$(c -b "$O" -X POST "$B/api/transfers/$TID2/cancel" -H 'Content-Type: application/json' -d '{}')" "422"
chk "cancel with a reason succeeds" \
  "$(c -b "$O" -X POST "$B/api/transfers/$TID2/cancel" -H 'Content-Type: application/json' \
     -H "Idempotency-Key: $(key)" -d '{"reason":"Van broke down"}')" "200"
chk "cancelled stock returns to the source" "$(onhand "$SHOP")" "$(( BEFORE_CANCEL + 2 ))"
chk "a second cancel is refused (D-27)" \
  "$(c -b "$O" -X POST "$B/api/transfers/$TID2/cancel" -H 'Content-Type: application/json' \
     -H "Idempotency-Key: $(key)" -d '{"reason":"Again"}')" "409"

printf "\n════ NF-5 idempotency ════\n"
KEY=$(key)
N_BEFORE=$(db "return p.prizeTransfer.count()")
j -b "$O" -X POST "$B/api/transfers" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
  -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$SHOP2\",\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"qty\":1}]}" >"$D/i1.json" &
j -b "$O" -X POST "$B/api/transfers" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" \
  -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$SHOP2\",\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"qty\":1}]}" >"$D/i2.json" &
wait
N_AFTER=$(db "return p.prizeTransfer.count()")
chk "a concurrent double-tap creates exactly one transfer" "$(( N_AFTER - N_BEFORE ))" "1"
chk "both taps receive the same transfer id" \
  "$([ "$(q '.id' <"$D/i1.json")" = "$(q '.id' <"$D/i2.json")" ] && echo same || echo different)" "same"

printf "\n════ §4.11 opname — anti-anchoring ════\n"
OP=$(j -b "$O" -X POST "$B/api/opname" -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\"}")
OPID=$(echo "$OP" | q ".id")
chk "starting a count reveals NO system quantity" \
  "$(echo "$OP" | node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));(d.items||[]).some(i=>'systemQty' in i||'qtyRemaining' in i)?'leaked':'clean'")" "clean"

SYS=$(onhand "$SHOP")
COUNTED=$(( SYS - 3 ))
LINES=$(j -b "$O" -X PUT "$B/api/opname/$OPID/lines" -H 'Content-Type: application/json' \
  -d "{\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"countedQty\":$COUNTED}]}")
chk "saving the count reveals the system quantity" \
  "$(echo "$LINES" | node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));(d.lines.find(l=>l.prizeItem.id==='$PRIZE')||{}).systemQty")" "$SYS"
chk "variance is computed server-side" \
  "$(echo "$LINES" | node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));(d.lines.find(l=>l.prizeItem.id==='$PRIZE')||{}).variance")" "-3"

printf "\n════ §16: an opname loss is shrinkage, not prize expense ════\n"
chk "commit succeeds" "$(c -b "$O" -X POST "$B/api/opname/$OPID/commit")" "200"
LOSS_TYPE=$(db "
  const m = await p.stockMovement.findFirst({where:{refId:'$OPID',prizeItemId:'$PRIZE'}});
  return m ? m.type : 'none';
")
chk "the movement is OPNAME_LOSS, never REDEEM" "$LOSS_TYPE" "OPNAME_LOSS"
chk "the shortfall left the source's on-hand" "$(onhand "$SHOP")" "$COUNTED"
chk "a second commit is refused" "$(c -b "$O" -X POST "$B/api/opname/$OPID/commit")" "409"

# Positive variance: §4.11 prices found stock at the weighted average, which is
# NOT the same rule as a manual adjustment (D-31 prices that at zero).
#
# This needs stock ON HAND to average over. By this point the transfers and the
# shortfall above have drained BR-1 to zero, and `weightedAverageCost` correctly
# returns 0 when there is nothing to average — documented behaviour, not a bug,
# but it would make this check assert nothing. So restock first.
j -b "$O" -X POST "$B/api/stock/batches" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PRIZE\",\"qtyReceived\":4,\"unitCogs\":2500,\"supplier\":\"P5\"}" >/dev/null

OP2=$(j -b "$O" -X POST "$B/api/opname" -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\"}" | q ".id")
SYS2=$(onhand "$SHOP")
j -b "$O" -X PUT "$B/api/opname/$OP2/lines" -H 'Content-Type: application/json' \
  -d "{\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"countedQty\":$(( SYS2 + 2 ))}]}" >/dev/null
j -b "$O" -X POST "$B/api/opname/$OP2/commit" >/dev/null
ADJ_COUNT=$(db "return p.prizeBatch.count({where:{shopId:'$SHOP',prizeItemId:'$PRIZE',isAdjustment:true}})")
chk "found stock creates an isAdjustment batch" "$ADJ_COUNT" "1"
# All remaining stock is the 4 @ 2500 just received, so the average is exactly
# 2500. Asserting the NUMBER rather than "> 0" is what makes this a real check.
ADJ_COST=$(db "
  const b = await p.prizeBatch.findFirst({where:{shopId:'$SHOP',prizeItemId:'$PRIZE',isAdjustment:true}});
  return b ? Number(b.unitCogs) : 'missing';
")
chk "found stock is priced at the weighted average, not zero" "$ADJ_COST" "2500"

printf "\n════ §4.11 / §7.5: variance VALUE is owner-only ════\n"
chk "owner sees varianceValue" \
  "$(j -b "$O" "$B/api/opname/$OPID" | node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));d.lines.some(l=>'varianceValue' in l)?'yes':'no'")" "yes"
chk "manager sees the variance QUANTITY" \
  "$(j -b "$M" "$B/api/opname/$OPID" | node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));d.lines.some(l=>'variance' in l)?'yes':'no'")" "yes"
chk "manager does NOT see varianceValue" \
  "$(j -b "$M" "$B/api/opname/$OPID" | node -pe "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));d.lines.some(l=>'varianceValue' in l)?'leaked':'clean'")" "clean"

# §7.5: scan the REAL serialized body a manager receives, not a DTO in isolation.
for EP in "/api/transfers" "/api/opname/$OPID"; do
  HIT=$(j -b "$M" "$B$EP" | tr 'A-Z' 'a-z' | grep -Eco 'cogs|unitcost|valuation|margin|profit|batchplan')
  chk "no cost string in $EP for a plain manager" "$HIT" "0"
done

printf "\n════ §3.4 permissions ════\n"
chk "STAFF is refused the transfer inbox" "$(c -b "$S" "$B/api/transfers")" "403"
chk "STAFF cannot dispatch" \
  "$(c -b "$S" -X POST "$B/api/transfers" -H 'Content-Type: application/json' \
     -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$SHOP2\",\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"qty\":1}]}")" "403"
chk "STAFF cannot start a stock count" \
  "$(c -b "$S" -X POST "$B/api/opname" -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\"}")" "403"
chk "a manager assigned to ONE end cannot transfer between two (§4.10)" \
  "$(c -b "$M" -X POST "$B/api/transfers" -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
     -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$SHOP2\",\"lines\":[{\"prizeItemId\":\"$PRIZE\",\"qty\":1}]}")" "403"
chk "a manager cannot count an unassigned shop" \
  "$(c -b "$M" -X POST "$B/api/opname" -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP2\"}")" "403"
chk "an unauthenticated caller is refused" "$(c "$B/api/transfers")" "401"

printf "\n════ §4.16 audit ════\n"
for ACTION in TRANSFER_DISPATCH TRANSFER_RECEIVE TRANSFER_CANCEL OPNAME_COMMIT; do
  SEEN=$(db "return (await p.auditLog.count({where:{action:'$ACTION'}})) > 0 ? 'yes' : 'no'")
  chk "$ACTION is audit-logged" "$SEEN" "yes"
done

printf "\n"
if [ "$FAILED" = "0" ]; then
  printf "\033[32m════ Phase 5 PASS ════\033[0m\n"
else
  printf "\033[31m════ Phase 5 FAIL ════\033[0m\n"
fi
rm -rf "$D"
exit "$FAILED"
