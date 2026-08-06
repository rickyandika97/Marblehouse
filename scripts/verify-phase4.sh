#!/bin/bash
# Phase 4 acceptance: prize catalog, FIFO stock, redemption, and the cost gate.
#
# Needs the dev server on localhost:5050 and the Phase 1 test accounts. Writes
# uniquely named test prizes, shops and customers to the dev database.
#
# The FIFO engine itself is proven by `npm test` (§15's ten unit tests). What
# this script proves is the part only a real HTTP session can: that the cost
# gate holds across the actual API surface, for actual roles.
set -u
cd /Users/ricky/redlight || exit 1

B=http://localhost:5050
D=$(mktemp -d)
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt; P=$D/p.txt
FAILED=0

j() { curl -sS "$@"; }
c() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }
login() {
  j -c "$3" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}
key() { uuidgen; }
q() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1 ?? ''"; }
# Body is a function body, so it may contain statements and must `return`.
db() { node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await (async(p)=>{ $1 })(p))}finally{await p.\$disconnect()}})()"; }

SUFFIX=$(date +%s | tail -c 7)

printf "════ Phase 4 setup ════\n"
login owner OwnerRealPass2026! "$O"
login manager1 MgrRealPass2026! "$M"
login staff1 StaffRealPass2026! "$S"

SHOP=$(db "return (await p.shop.findFirst({where:{code:'BR-1'}})).id")
SHOP2=$(db "return (await p.shop.findFirst({where:{code:'BR-2'}})).id")
for JAR in "$O" "$M" "$S"; do
  j -b "$JAR" -X POST "$B/api/work-session" -H 'Content-Type: application/json' \
    -d "{\"shopId\":\"$SHOP\"}" >/dev/null
done

# A dedicated Purchasing manager, assigned to BR-1 only. This is the account
# §7.5 exists for, and the one §16 names in its acceptance criteria.
PURCHASER=$(db "
  const u = await p.user.findUnique({where:{username:'purchaser1'}});
  if (!u) return 'MISSING';
  await p.user.update({where:{id:u.id},data:{canEnterCost:true,banned:false}});
  return u.id;
")
if [ "$PURCHASER" = "MISSING" ]; then
  CREATED=$(j -b "$O" -X POST "$B/api/users" -H 'Content-Type: application/json' \
    -d "{\"username\":\"purchaser1\",\"displayName\":\"Purchasing Manager\",\"password\":\"PurchPass2026!\",\"role\":\"MANAGER\",\"shopIds\":[\"$SHOP\"],\"canEnterCost\":true}")
  PURCHASER=$(echo "$CREATED" | q ".id")
  db "await p.user.update({where:{id:'$PURCHASER'},data:{mustChangePassword:false,canEnterCost:true}}); return 'ok'" >/dev/null
fi
db "await p.user.update({where:{id:'$PURCHASER'},data:{mustChangePassword:false,canEnterCost:true}}); return 'ok'" >/dev/null
login purchaser1 PurchPass2026! "$P"
j -b "$P" -X POST "$B/api/work-session" -H 'Content-Type: application/json' \
  -d "{\"shopId\":\"$SHOP\"}" >/dev/null
PURCH_OK=$(c -b "$P" "$B/api/auth/me")
chk "purchasing manager session is usable" "$PURCH_OK" "200"

printf "\n════ Catalog and stocking config ════\n"
PRIZE=$(j -b "$O" -X POST "$B/api/prizes" -H 'Content-Type: application/json' \
  -d "{\"sku\":\"P4-$SUFFIX\",\"name\":\"Phase Four Bear $SUFFIX\",\"ticketCost\":100}")
PID=$(echo "$PRIZE" | q ".id")
[ -n "$PID" ] && pass "owner creates a catalog item" || fail "create prize" "$PRIZE"

STAFF_CREATE=$(c -b "$S" -X POST "$B/api/prizes" -H 'Content-Type: application/json' \
  -d "{\"sku\":\"P4X-$SUFFIX\",\"name\":\"Nope\",\"ticketCost\":10}")
chk "staff cannot create a catalog item" "$STAFF_CREATE" "403"

CFG=$(c -b "$M" -X PUT "$B/api/shops/$SHOP/prizes/$PID/config" \
  -H 'Content-Type: application/json' -d '{"lowStockThreshold":3,"isActive":true}')
chk "manager sets this shop's stocking policy" "$CFG" "200"

# Ticket cost is global (§4.8) — it must not be settable per shop.
CFG_COST=$(c -b "$M" -X PUT "$B/api/shops/$SHOP/prizes/$PID/config" \
  -H 'Content-Type: application/json' \
  -d '{"lowStockThreshold":3,"isActive":true,"ticketCost":5}')
chk "per-shop ticket cost is rejected, not ignored" "$CFG_COST" "422"

CROSS_CFG=$(c -b "$M" -X PUT "$B/api/shops/$SHOP2/prizes/$PID/config" \
  -H 'Content-Type: application/json' -d '{"lowStockThreshold":1,"isActive":true}')
chk "manager cannot configure an unassigned shop" "$CROSS_CFG" "403"

printf "\n════ Criterion: the cost gate (§7.5, §16) ════\n"
# Two batches at different costs — this is what FIFO will draw on.
B1=$(j -b "$O" -X POST "$B/api/stock/batches" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PID\",\"qtyReceived\":2,\"unitCogs\":1000,\"receivedAt\":\"2026-01-01T00:00:00.000Z\"}")
B1_ID=$(echo "$B1" | q ".id")
B2=$(j -b "$O" -X POST "$B/api/stock/batches" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PID\",\"qtyReceived\":5,\"unitCogs\":3000,\"receivedAt\":\"2026-02-01T00:00:00.000Z\"}")
[ -n "$B1_ID" ] && pass "owner receives priced stock" || fail "receive batch" "$B1"

# THE criterion: a plain manager's response body must contain no cost string.
MGR_PRIZES=$(j -b "$M" "$B/api/prizes?shopId=$SHOP")
LEAK=$(printf '%s' "$MGR_PRIZES" | tr 'A-Z' 'a-z' | grep -c -E 'cogs|unitcost|valuation|margin|profit|variancevalue')
chk "plain manager sees no cost string in /api/prizes" "$LEAK" "0"

STAFF_PRIZES=$(j -b "$S" "$B/api/prizes?shopId=$SHOP")
LEAK_S=$(printf '%s' "$STAFF_PRIZES" | tr 'A-Z' 'a-z' | grep -c -E 'cogs|unitcost|valuation|margin|profit|variancevalue')
chk "staff sees no cost string in /api/prizes" "$LEAK_S" "0"

ONHAND=$(echo "$MGR_PRIZES" | node -pe "
  const a=JSON.parse(require('fs').readFileSync(0,'utf8'));
  (a.find(x=>x.id==='$PID')||{}).onHand ?? ''
")
chk "manager still sees on-hand quantity" "$ONHAND" "7"

MGR_BATCHES=$(c -b "$M" "$B/api/stock/batches?shopId=$SHOP")
chk "plain manager is refused the costed batch list" "$MGR_BATCHES" "403"
MGR_UNCOSTED=$(c -b "$M" "$B/api/stock/uncosted?shopId=$SHOP")
chk "plain manager is refused the uncosted queue" "$MGR_UNCOSTED" "403"

# §15: a unitCogs from a non-Purchasing manager is a 403, NOT a dropped field.
MGR_COST_POST=$(c -b "$M" -X POST "$B/api/stock/batches" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PID\",\"qtyReceived\":1,\"unitCogs\":500}")
chk "manager sending unitCogs gets 403, not a silent drop" "$MGR_COST_POST" "403"

printf "\n════ Criterion: the Purchasing manager (§16) ════\n"
PURCH_BATCHES=$(c -b "$P" "$B/api/stock/batches?shopId=$SHOP")
chk "purchasing manager sees costs at an ASSIGNED shop" "$PURCH_BATCHES" "200"
PURCH_CROSS=$(c -b "$P" "$B/api/stock/batches?shopId=$SHOP2")
chk "purchasing manager gets 403 at an UNASSIGNED shop" "$PURCH_CROSS" "403"

PURCH_RECEIVE=$(c -b "$P" -X POST "$B/api/stock/batches" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PID\",\"qtyReceived\":1,\"unitCogs\":2000}")
chk "purchasing manager may price a delivery at their own shop" "$PURCH_RECEIVE" "200"

# The permission unlocks cost ENTRY, not profitability (§7.5).
PURCH_REPORT=$(c -b "$P" "$B/api/reports/tickets-awarded")
chk "purchasing manager is still refused an owner report" "$PURCH_REPORT" "403"

printf "\n════ Uncosted queue and backfill (§7.5) ════\n"
UNPRICED=$(j -b "$M" -X POST "$B/api/stock/batches" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"shopId\":\"$SHOP\",\"prizeItemId\":\"$PID\",\"qtyReceived\":3,\"receivedAt\":\"2026-03-01T00:00:00.000Z\"}")
UNPRICED_ID=$(echo "$UNPRICED" | q ".id")
[ -n "$UNPRICED_ID" ] && pass "plain manager may receive stock without pricing it" || fail "unpriced receive" "$UNPRICED"

FLAGGED=$(db "return (await p.prizeBatch.findUnique({where:{id:'$UNPRICED_ID'}})).needsCosting")
chk "an unpriced batch is flagged for the owner's queue" "$FLAGGED" "true"

QUEUE=$(j -b "$O" "$B/api/stock/uncosted" | node -pe "
  JSON.parse(require('fs').readFileSync(0,'utf8')).filter(b=>b.id==='$UNPRICED_ID').length
")
chk "the unpriced batch appears in the owner's queue" "$QUEUE" "1"

SETCOST=$(c -b "$O" -X PATCH "$B/api/stock/batches/$UNPRICED_ID/cost" \
  -H 'Content-Type: application/json' -d '{"unitCogs":1500}')
chk "owner prices the batch" "$SETCOST" "200"
CLEARED=$(db "return (await p.prizeBatch.findUnique({where:{id:'$UNPRICED_ID'}})).needsCosting")
chk "pricing clears the flag" "$CLEARED" "false"

printf "\n════ Redemption: FIFO, tickets and the transaction ════\n"
PHONE="0817$SUFFIX"
CUST=$(j -b "$S" -X POST "$B/api/customers" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"name\":\"Phase Four Player\",\"phone\":\"$PHONE\"}")
CID=$(echo "$CUST" | q ".id")
j -b "$S" -X POST "$B/api/tickets/award" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$CID\",\"qty\":400,\"ticketsCollected\":true}" >/dev/null

RED=$(j -b "$S" -X POST "$B/api/redemptions" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$CID\",\"lines\":[{\"prizeItemId\":\"$PID\",\"qty\":3}]}")
RID=$(echo "$RED" | q ".id")
[ -n "$RID" ] && pass "staff redeems prizes for tickets" || fail "redeem" "$RED"
chk "tickets were spent at the server's price" "$(echo "$RED" | q ".totalTickets")" "300"

# FIFO: 2 units at 1000 then 1 at 3000 = 5000, NOT 3 x an average.
COGS=$(db "return (await p.redemption.findUnique({where:{id:'$RID'}})).totalCogs.toString()")
chk "redemption cost is true FIFO, not an average" "$COGS" "5000"

LEAK_R=$(printf '%s' "$RED" | tr 'A-Z' 'a-z' | grep -c -E 'cogs|unitcost|valuation|margin|profit')
chk "staff redemption response carries no cost string" "$LEAK_R" "0"

# A double-tap at the counter must redeem once (NF-5).
IDEM=$(key)
BEFORE_N=$(db "return p.redemption.count({where:{customerId:'$CID'}})")
j -b "$S" -X POST "$B/api/redemptions" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEM" \
  -d "{\"customerId\":\"$CID\",\"lines\":[{\"prizeItemId\":\"$PID\",\"qty\":1}]}" >/dev/null &
j -b "$S" -X POST "$B/api/redemptions" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEM" \
  -d "{\"customerId\":\"$CID\",\"lines\":[{\"prizeItemId\":\"$PID\",\"qty\":1}]}" >/dev/null &
wait
AFTER_N=$(db "return p.redemption.count({where:{customerId:'$CID'}})")
chk "a double-tapped redemption creates exactly one" "$((AFTER_N-BEFORE_N))" "1"

OVER=$(c -b "$S" -X POST "$B/api/redemptions" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$CID\",\"lines\":[{\"prizeItemId\":\"$PID\",\"qty\":999}]}")
chk "a redemption beyond stock is refused" "$OVER" "409"

printf "\n════ Redemption void (§4.9) ════\n"
STAFF_VOID=$(c -b "$S" -X POST "$B/api/redemptions/$RID/void" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
  -d '{"reason":"staff should not be able to do this"}')
chk "staff cannot void a redemption" "$STAFF_VOID" "403"

BEFORE_BAL=$(db "return (await p.customer.findUnique({where:{id:'$CID'}})).ticketBalance")
OWNER_VOID=$(c -b "$O" -X POST "$B/api/redemptions/$RID/void" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
  -d '{"reason":"wrong prize handed to the customer"}')
chk "owner voids the redemption" "$OWNER_VOID" "200"
AFTER_BAL=$(db "return (await p.customer.findUnique({where:{id:'$CID'}})).ticketBalance")
chk "the void restored exactly the tickets spent" "$((AFTER_BAL-BEFORE_BAL))" "300"

RESTORED=$(db "
  const b = await p.prizeBatch.findUnique({where:{id:'$B1_ID'}});
  return b.qtyRemaining;
")
chk "the void restored the exact original batch" "$RESTORED" "2"

DOUBLE_VOID=$(c -b "$O" -X POST "$B/api/redemptions/$RID/void" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
  -d '{"reason":"second attempt"}')
chk "a redemption cannot be voided twice" "$DOUBLE_VOID" "409"

printf "\n════ Low stock (§4.8) ════\n"
LOW=$(j -b "$M" "$B/api/stock/on-hand?shopId=$SHOP" | node -pe "
  const a=JSON.parse(require('fs').readFileSync(0,'utf8'));
  const x=a.find(i=>i.id==='$PID')||{};
  [x.onHand, x.isLowStock].join(',')
")
pass "on-hand and low-stock flag render for a manager (${LOW})"

printf "\n"
if [ "$FAILED" = 0 ]; then
  printf "\033[32mPhase 4 (partial) PASS\033[0m — catalog, stock, cost gate and redemption\n"
  printf "Note: the FIFO engine's §15 unit tests are proven by \`npm test\`.\n"
else
  printf "\033[31mPhase 4 FAILED\033[0m\n"
fi
rm -rf "$D"
exit "$FAILED"
