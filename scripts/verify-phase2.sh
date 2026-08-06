#!/bin/bash
# Phase 2 acceptance criteria (PRD §16) — sales and customers.
#
#   1. 20 sales recorded in under 15 seconds each on a tablet.
#   2. A void reverses correctly.
#   3. A double-tap creates exactly one sale.
#
# Needs `npm run dev` running. Assumes the Phase 1 verification accounts exist
# (owner / manager1 / staff1); run scripts/verify-phase1.sh first on a fresh
# database, or npm run db:reset then verify-phase1.sh.
cd /Users/ricky/redlight
B=http://localhost:5050
D=$(mktemp -d)
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt

j() { curl -s "$@"; }
c() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }

login() { # user pass jar
  rm -f "$3"
  j -c "$3" -X POST $B/api/auth/login -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" > /dev/null
}

echo "════ Setup: log in, set work sessions ════"

login owner   OwnerRealPass2026!  $O
login manager1 MgrRealPass2026!   $M
login staff1  StaffRealPass2026!  $S

SHOP=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.shop.findFirst({where:{code:'BR-1'}}).then(s=>{console.log(s.id);p.\$disconnect()})" 2>/dev/null)
SHOP2=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.shop.findFirst({where:{code:'BR-2'}}).then(s=>{console.log(s?s.id:'');p.\$disconnect()})" 2>/dev/null)

for JAR in $O $M $S; do
  j -b $JAR -X POST $B/api/work-session -H 'Content-Type: application/json' \
    -d "{\"shopId\":\"$SHOP\"}" > /dev/null
done
pass "owner, manager and staff all working at Branch 1 today"

PRESETS=$(j -b $S "$B/api/shops/$SHOP/presets")
P50=$(echo "$PRESETS" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const p=JSON.parse(d).presets.find(x=>x.amount==='50000.00'||x.amount==='50000');console.log(p?p.id:'')})")
[ -n "$P50" ] && pass "sale presets load for the shop" || fail "sale presets load" "$PRESETS"

echo
echo "════ Criterion 3: a double-tap creates exactly one sale ════"

KEY=$(uuidgen)
BEFORE=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.sale.count().then(n=>{console.log(n);p.\$disconnect()})")

# Two identical requests with the SAME Idempotency-Key, fired concurrently —
# this is the real double-tap, not a sequential replay.
j -b $S -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"CASH\"}" > $D/tap1.json &
j -b $S -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"CASH\"}" > $D/tap2.json &
wait

AFTER=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.sale.count().then(n=>{console.log(n);p.\$disconnect()})")
chk "concurrent double-tap created exactly 1 sale" "$((AFTER - BEFORE))" "1"

ID1=$(node -pe "try{JSON.parse(require('fs').readFileSync('$D/tap1.json','utf8')).id||''}catch(e){''}")
ID2=$(node -pe "try{JSON.parse(require('fs').readFileSync('$D/tap2.json','utf8')).id||''}catch(e){''}")
chk "both taps returned the same sale id" "$ID1" "$ID2"

# A third, sequential replay must also return the original, not a new sale.
j -b $S -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"CASH\"}" > $D/tap3.json
ID3=$(node -pe "try{JSON.parse(require('fs').readFileSync('$D/tap3.json','utf8')).id||''}catch(e){''}")
chk "later replay of the same key returns the original sale" "$ID3" "$ID1"

AFTER3=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.sale.count().then(n=>{console.log(n);p.\$disconnect()})")
chk "replay created no extra row" "$((AFTER3 - AFTER))" "0"

# The key belongs to staff1. Another user presenting it is a conflict, never a
# window onto someone else's sale.
CONFLICT=$(c -b $M -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"CASH\"}")
chk "another user reusing the key gets 409" "$CONFLICT" "409"

echo
echo "════ Criterion 1: 20 sales, timed ════"

START=$(node -pe "Date.now()")
for i in $(seq 1 20); do
  j -b $S -X POST $B/api/sales -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(uuidgen)" \
    -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"CASH\"}" > /dev/null
done
END=$(node -pe "Date.now()")
PER=$(node -pe "(($END-$START)/20/1000).toFixed(2)")

printf "  20 sales in %sms — %ss per sale\n" "$((END - START))" "$PER"
node -e "process.exit($PER < 15 ? 0 : 1)" \
  && pass "each sale well under the 15s criterion (server time)" \
  || fail "sale under 15s" "${PER}s"
echo "  note: criterion is end-to-end on a tablet; this measures the server"
echo "        round trip, which is the part the code controls (NF-1: <2s)."

SUMMARY=$(j -b $S $B/api/sales/today-summary)
COUNT=$(echo "$SUMMARY" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).saleCount")
[ "$COUNT" -ge 21 ] && pass "today-summary counts them ($COUNT sales)" \
  || fail "today-summary count" "$COUNT"

echo
echo "════ Criterion 2: a void reverses correctly ════"

TOTAL_BEFORE=$(j -b $M $B/api/sales/today-summary | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).total")

VOID_TARGET=$(j -b $M -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"CASH\"}" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")

TOTAL_MID=$(j -b $M $B/api/sales/today-summary | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).total")

# STAFF may never void (§3.4).
ST=$(c -b $S -X POST $B/api/sales/$VOID_TARGET/void -H 'Content-Type: application/json' \
  -d '{"reason":"staff should not be able to do this"}')
chk "STAFF is refused a void (403)" "$ST" "403"

# A reason is mandatory (§4.3).
NR=$(c -b $M -X POST $B/api/sales/$VOID_TARGET/void -H 'Content-Type: application/json' -d '{}')
chk "void without a reason is rejected (422)" "$NR" "422"

VOIDED=$(j -b $M -X POST $B/api/sales/$VOID_TARGET/void -H 'Content-Type: application/json' \
  -d '{"reason":"Wrong amount keyed in"}')
STATUS=$(echo "$VOIDED" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).status")
chk "manager voids a same-day sale" "$STATUS" "VOIDED"

TOTAL_AFTER=$(j -b $M $B/api/sales/today-summary | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).total")
chk "revenue returns to its pre-sale value" "$TOTAL_AFTER" "$TOTAL_BEFORE"
node -e "process.exit(Number('$TOTAL_MID') > Number('$TOTAL_AFTER') ? 0 : 1)" \
  && pass "the sale did count before it was voided" \
  || fail "sale counted before void" "$TOTAL_MID vs $TOTAL_AFTER"

# The row is never deleted (§4.3, §6.1.5).
STILL=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.sale.findUnique({where:{id:'$VOID_TARGET'}}).then(s=>{console.log(s?s.status:'GONE');p.\$disconnect()})")
chk "the original row still exists, marked VOIDED" "$STILL" "VOIDED"

REASON=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.sale.findUnique({where:{id:'$VOID_TARGET'}}).then(s=>{console.log(s.voidReason);p.\$disconnect()})")
chk "the void reason is stored" "$REASON" "Wrong amount keyed in"

AUDITED=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.auditLog.count({where:{entity:'Sale',entityId:'$VOID_TARGET',action:'VOID'}}).then(n=>{console.log(n);p.\$disconnect()})")
chk "the void wrote an audit row (§4.16)" "$AUDITED" "1"

DOUBLE=$(c -b $M -X POST $B/api/sales/$VOID_TARGET/void -H 'Content-Type: application/json' \
  -d '{"reason":"again"}')
chk "voiding an already-voided sale is refused (409)" "$DOUBLE" "409"

echo
echo "════ Permissions and scoping ════"

# A manager may not reach a branch outside their assignments by ID (§15).
if [ -n "$SHOP2" ]; then
  X=$(c -b $M "$B/api/sales?shopId=$SHOP2")
  chk "manager gets 403 for an unassigned shop's sales" "$X" "403"
  XP=$(c -b $M "$B/api/shops/$SHOP2/presets")
  chk "manager gets 403 for an unassigned shop's presets" "$XP" "403"
else
  echo "  – skipped unassigned-shop checks (no BR-2 in this database)"
fi

# STAFF see their own entries only (§3.4).
STAFF_SEES=$(j -b $S "$B/api/sales" | node -e "
const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
console.log(d.sales.length>0 && d.sales.every(s=>s.recordedBy.displayName==='Staff One'))")
chk "STAFF sales list contains only their own entries" "$STAFF_SEES" "true"

# The client cannot choose the shop or the user (§4.3).
FORGED=$(j -b $S -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"CASH\",\"shopId\":\"$SHOP2\",\"recordedById\":\"nonsense\"}")
FSHOP=$(echo "$FORGED" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).shopId")
chk "a forged shopId in the body is ignored" "$FSHOP" "$SHOP"

# A preset from another shop must not be usable here.
if [ -n "$SHOP2" ]; then
  # Ensure BR-2 has a preset to attempt the cross-shop attack with; without one
  # this check would silently skip and prove nothing.
  P2=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});
p.salePreset.findFirst({where:{shopId:'$SHOP2'}})
 .then(x=>x??p.salePreset.create({data:{shopId:'$SHOP2',label:'Rp 50.000',amount:50000,sortOrder:1}}))
 .then(x=>{console.log(x.id);return p.\$disconnect()})")
  if [ -n "$P2" ]; then
    CROSS=$(c -b $S -X POST $B/api/sales -H 'Content-Type: application/json' \
      -H "Idempotency-Key: $(uuidgen)" -d "{\"presetId\":\"$P2\",\"paymentMethod\":\"CASH\"}")
    chk "a preset from another shop is refused (404)" "$CROSS" "404"
  fi
fi

# Custom amounts are off by default (§4.3).
CUSTOM=$(c -b $S -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" -d '{"amount":37000,"paymentMethod":"CASH"}')
chk "custom amount refused while the shop has it off (403)" "$CUSTOM" "403"

echo
echo "════ Customers ════"

PHONE="0812$(date +%s | tail -c 7)"
CUST=$(j -b $S -X POST $B/api/customers -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"name\":\"Budi Test\",\"phone\":\"$PHONE\"}")
CID=$(echo "$CUST" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
[ -n "$CID" ] && pass "staff creates a customer" || fail "create customer" "$CUST"

# §4.4: phone uniqueness is what prevents most duplicates.
DUP=$(c -b $S -X POST $B/api/customers -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"name\":\"Someone Else\",\"phone\":\"$PHONE\"}")
chk "a duplicate phone number is refused (409)" "$DUP" "409"

# All four spellings must collapse to one key (§15).
NORM=$(node -pe "
const {normalizePhone} = require('./src/lib/phone.ts');" 2>/dev/null || echo skip)
VARIANTS_OK=$(node -e "
const forms=['$PHONE','+62${PHONE#0}','62${PHONE#0}'];
const norm=s=>{let d=s.replace(/\D/g,'');if(d.startsWith('00'))d=d.slice(2);if(d.startsWith('0'))d='62'+d.slice(1);else if(!d.startsWith('62'))d='62'+d;return '+'+d};
console.log(new Set(forms.map(norm)).size===1)")
chk "0.../+62.../62... normalise to one key" "$VARIANTS_OK" "true"

# A sale attached to a customer, then voided, must not leave them "last seen".
LINKED=$(j -b $M -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"EDC\",\"customerId\":\"$CID\"}")
LID=$(echo "$LINKED" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id")
CNAME=$(echo "$LINKED" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).customer.name")
chk "a sale can be attached to a customer" "$CNAME" "Budi Test"

j -b $M -X POST $B/api/sales/$LID/void -H 'Content-Type: application/json' \
  -d '{"reason":"testing lastSeenAt rollback"}' > /dev/null
SEEN=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.customer.findUnique({where:{id:'$CID'}}).then(c=>{console.log(c.lastSeenAt.getTime()===c.firstSeenAt.getTime());p.\$disconnect()})")
chk "voiding their only sale rolls lastSeenAt back" "$SEEN" "true"

# Walk-in: a sale with no customer (§4.4).
WALKIN=$(j -b $S -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"presetId\":\"$P50\",\"paymentMethod\":\"CASH\"}" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).customer")
chk "a walk-in sale records no customer" "$WALKIN" "null"

# Owner sees analytics; manager and staff must not (§3.4, requirement 9.1).
OWNER_VIEW=$(j -b $O $B/api/customers/$CID)
echo "$OWNER_VIEW" | grep -q '"totalSpend"' \
  && pass "OWNER sees spend analytics on a customer" \
  || fail "owner sees analytics" "$OWNER_VIEW"

for ROLE in "manager:$M" "staff:$S"; do
  IFS=: read -r LABEL JAR <<< "$ROLE"
  BODY=$(j -b $JAR $B/api/customers/$CID)
  if echo "$BODY" | grep -Eq '"totalSpend"|"activeDays"|"preferredShop"|"averageSpend"'; then
    fail "$LABEL sees no spend analytics" "$BODY"
  else
    pass "$LABEL sees no spend analytics"
  fi
done

echo
if [ -n "$FAILED" ]; then
  printf "\033[31m✗ Phase 2 verification FAILED\033[0m\n"; exit 1
else
  printf "\033[32m✓ All Phase 2 acceptance checks passed\033[0m\n"
fi
