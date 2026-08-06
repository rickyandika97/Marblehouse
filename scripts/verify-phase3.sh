#!/bin/bash
# Phase 3 acceptance: ledgers, cached balances, guards, reconciliation,
# ticket-award controls/report, and customer merge.
#
# Needs the dev server on localhost:5050 and Phase 1 test accounts. Writes only
# uniquely named test customers and their transactions to the dev database.
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
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }
login() {
  j -c "$3" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}
key() { uuidgen; }

printf "════ Phase 3 setup ════\n"
login owner OwnerRealPass2026! "$O"
login manager1 MgrRealPass2026! "$M"
login staff1 StaffRealPass2026! "$S"

SHOP=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.shop.findFirst({where:{code:'BR-1'}}).then(x=>{console.log(x?.id??'');return p.\$disconnect()})")
for JAR in "$O" "$M" "$S"; do
  j -b "$JAR" -X POST "$B/api/work-session" -H 'Content-Type: application/json' \
    -d "{\"shopId\":\"$SHOP\"}" >/dev/null
done

PHONE="0813$(date +%s | tail -c 7)"
CUSTOMER=$(j -b "$S" -X POST "$B/api/customers" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
  -d "{\"name\":\"Phase Three Main\",\"phone\":\"$PHONE\"}")
CID=$(echo "$CUSTOMER" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id??''")
[ -n "$CID" ] && pass "created a dedicated Phase 3 customer" || fail "create Phase 3 customer" "$CUSTOMER"

printf "\n════ Criterion 1: 50 mixed operations ════\n"
OPS_OK=1
for _ in $(seq 1 20); do
  ST=$(c -b "$S" -X POST "$B/api/marbles/deposit" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(key)" -d "{\"customerId\":\"$CID\",\"qty\":2}")
  [ "$ST" = 200 ] || OPS_OK=0
done
for _ in $(seq 1 10); do
  ST=$(c -b "$S" -X POST "$B/api/marbles/withdraw" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(key)" -d "{\"customerId\":\"$CID\",\"qty\":1}")
  [ "$ST" = 200 ] || OPS_OK=0
done
for _ in $(seq 1 15); do
  ST=$(c -b "$S" -X POST "$B/api/tickets/award" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(key)" \
    -d "{\"customerId\":\"$CID\",\"qty\":3,\"ticketsCollected\":true}")
  [ "$ST" = 200 ] || OPS_OK=0
done
for _ in $(seq 1 5); do
  ST=$(c -b "$M" -X POST "$B/api/tickets/adjust" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(key)" \
    -d "{\"customerId\":\"$CID\",\"delta\":1,\"reason\":\"Phase 3 verification correction\"}")
  [ "$ST" = 200 ] || OPS_OK=0
done
[ "$OPS_OK" = 1 ] && pass "all 50 mixed operations succeeded" || fail "50 mixed operations" "one or more requests failed"

STATE=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});Promise.all([p.customer.findUnique({where:{id:'$CID'}}),p.marbleLedger.aggregate({where:{customerId:'$CID'},_sum:{delta:true},_count:{_all:true}}),p.ticketLedger.aggregate({where:{customerId:'$CID'},_sum:{delta:true},_count:{_all:true}})]).then(([c,m,t])=>{console.log([c.marbleBalance,c.ticketBalance,m._sum.delta,t._sum.delta,m._count._all+t._count._all].join(','));return p.\$disconnect()})")
chk "50 operations left exact caches and ledger sums" "$STATE" "30,50,30,50,50"

printf "\n════ Negative balance and concurrency guards ════\n"
OVER=$(c -b "$S" -X POST "$B/api/marbles/withdraw" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"customerId\":\"$CID\",\"qty\":31}")
chk "withdraw below zero is rejected" "$OVER" "409"
UNCHANGED=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.customer.findUnique({where:{id:'$CID'}}).then(x=>{console.log(x.marbleBalance);return p.\$disconnect()})")
chk "failed withdrawal wrote no partial balance" "$UNCHANGED" "30"

RACE_PHONE="0814$(date +%s | tail -c 7)"
RACE=$(j -b "$S" -X POST "$B/api/customers" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"name\":\"Phase Three Race\",\"phone\":\"$RACE_PHONE\"}")
RID=$(echo "$RACE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id??''")
j -b "$S" -X POST "$B/api/marbles/deposit" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"customerId\":\"$RID\",\"qty\":10}" >/dev/null
j -b "$S" -o "$D/race1.json" -w "%{http_code}" -X POST "$B/api/marbles/withdraw" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$RID\",\"qty\":8}" >"$D/race1.status" &
j -b "$S" -o "$D/race2.json" -w "%{http_code}" -X POST "$B/api/marbles/withdraw" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$RID\",\"qty\":8}" >"$D/race2.status" &
wait
RACE_STATUS=$(printf "%s\n%s\n" "$(sed -n '1p' "$D/race1.status")" "$(sed -n '1p' "$D/race2.status")" | sort | tr '\n' ' ' | sed 's/ $//')
chk "two concurrent withdrawals allow exactly one" "$RACE_STATUS" "200 409"
RACE_BAL=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.customer.findUnique({where:{id:'$RID'}}).then(x=>{console.log(x.marbleBalance);return p.\$disconnect()})")
chk "concurrent withdrawal leaves non-negative balance" "$RACE_BAL" "2"

printf "\n════ Ticket award controls and permissions ════\n"
NO_COLLECT=$(c -b "$S" -X POST "$B/api/tickets/award" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"customerId\":\"$CID\",\"qty\":1}")
chk "award requires tickets-counted-and-collected confirmation" "$NO_COLLECT" "422"
NO_REASON=$(c -b "$S" -X POST "$B/api/tickets/award" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$CID\",\"qty\":501,\"ticketsCollected\":true}")
chk "award above 500 without reason is rejected" "$NO_REASON" "422"
WITH_REASON=$(c -b "$S" -X POST "$B/api/tickets/award" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$CID\",\"qty\":501,\"ticketsCollected\":true,\"note\":\"Tournament payout checked by manager\"}")
chk "award above 500 succeeds with a reason" "$WITH_REASON" "200"

STAFF_ADJUST=$(c -b "$S" -X POST "$B/api/marbles/adjust" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$CID\",\"delta\":-5,\"reason\":\"should be forbidden\"}")
chk "staff cannot manually adjust balances" "$STAFF_ADJUST" "403"
MANAGER_ADJUST=$(c -b "$M" -X POST "$B/api/marbles/adjust" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" \
  -d "{\"customerId\":\"$CID\",\"delta\":-5,\"reason\":\"Physical recount correction\"}")
chk "manager can adjust with a reason" "$MANAGER_ADJUST" "200"

MANAGER_REPORT=$(c -b "$M" "$B/api/reports/tickets-awarded")
chk "manager cannot view the fraud-control report" "$MANAGER_REPORT" "403"
OWNER_REPORT=$(j -b "$O" "$B/api/reports/tickets-awarded")
REPORT_HAS_STAFF=$(echo "$OWNER_REPORT" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).rows.some(x=>x.staff.displayName==='Staff One'&&x.ticketsAwarded>=501)")
chk "owner report groups ticket awards by staff/day" "$REPORT_HAS_STAFF" "true"

MANAGER_SETTING=$(c -b "$M" "$B/api/settings/ticket-award-threshold")
chk "manager cannot read the owner threshold setting" "$MANAGER_SETTING" "403"
SET600=$(c -b "$O" -X PATCH "$B/api/settings/ticket-award-threshold" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d '{"threshold":600}')
chk "owner can change the award threshold" "$SET600" "200"
GOT600=$(j -b "$O" "$B/api/settings/ticket-award-threshold" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).threshold")
chk "changed threshold reads back" "$GOT600" "600"
j -b "$O" -X PATCH "$B/api/settings/ticket-award-threshold" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d '{"threshold":500}' >/dev/null
pass "restored the configured threshold to 500"

printf "\n════ History pagination and idempotency ════\n"
PAGE1=$(j -b "$S" "$B/api/customers/$CID/ledger")
P1_COUNT=$(echo "$PAGE1" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).entries.length")
CURSOR=$(echo "$PAGE1" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).nextCursor??''")
chk "history page is capped at 50 rows" "$P1_COUNT" "50"
[ -n "$CURSOR" ] && pass "history supplies an opaque next cursor" || fail "history next cursor" "missing"
ENCODED_CURSOR=$(node -pe "encodeURIComponent('$CURSOR')")
PAGE2=$(j -b "$S" "$B/api/customers/$CID/ledger?cursor=$ENCODED_CURSOR")
P2_COUNT=$(echo "$PAGE2" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).entries.length")
[ "$P2_COUNT" -ge 2 ] && pass "older history loads without an unbounded query" || fail "older history page" "$P2_COUNT rows"

IDEM_KEY=$(key)
BEFORE_IDEM=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.marbleLedger.count({where:{customerId:'$CID'}}).then(x=>{console.log(x);return p.\$disconnect()})")
j -b "$S" -X POST "$B/api/marbles/deposit" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEM_KEY" -d "{\"customerId\":\"$CID\",\"qty\":4}" >/dev/null
j -b "$S" -X POST "$B/api/marbles/deposit" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEM_KEY" -d "{\"customerId\":\"$CID\",\"qty\":4}" >/dev/null
AFTER_IDEM=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.marbleLedger.count({where:{customerId:'$CID'}}).then(x=>{console.log(x);return p.\$disconnect()})")
chk "replayed mutation creates one ledger row" "$((AFTER_IDEM-BEFORE_IDEM))" "1"

printf "\n════ Criterion 2: reconciliation and durable alert ════\n"
NODE_ENV=production ./node_modules/.bin/tsx --env-file=.env scripts/reconcile-balances.ts >"$D/reconcile-zero.json"
ZERO=$(node -pe "JSON.parse(require('fs').readFileSync('$D/reconcile-zero.json','utf8')).corrected")
chk "reconciliation initially reports zero drift" "$ZERO" "0"

node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});p.customer.update({where:{id:'$CID'},data:{marbleBalance:{increment:7}}}).finally(()=>p.\$disconnect())"
NODE_ENV=production ./node_modules/.bin/tsx --env-file=.env scripts/reconcile-balances.ts >"$D/reconcile-drift.json"
CORRECTED=$(node -pe "JSON.parse(require('fs').readFileSync('$D/reconcile-drift.json','utf8')).corrected")
chk "reconciliation detects and corrects drift" "$CORRECTED" "1"
DRIFT_PROOF=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});Promise.all([p.systemAlert.count({where:{key:'BALANCE_DRIFT:$CID',isActive:true}}),p.auditLog.count({where:{entityId:'$CID',action:'BALANCE_RECONCILED'}})]).then(x=>{console.log(x.join(','));return p.\$disconnect()})")
chk "drift leaves a persistent critical alert and audit row" "$DRIFT_PROOF" "1,1"

printf "\n════ Customer merge ════\n"
LOSER_PHONE="0815$(date +%s | tail -c 7)"
LOSER=$(j -b "$S" -X POST "$B/api/customers" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"name\":\"Phase Three Duplicate\",\"phone\":\"$LOSER_PHONE\"}")
LID=$(echo "$LOSER" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).id??''")
j -b "$S" -X POST "$B/api/marbles/deposit" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"customerId\":\"$LID\",\"qty\":7}" >/dev/null
j -b "$S" -X POST "$B/api/tickets/award" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"customerId\":\"$LID\",\"qty\":9,\"ticketsCollected\":true}" >/dev/null
MANAGER_MERGE=$(c -b "$M" -X POST "$B/api/customers/merge" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"winnerId\":\"$CID\",\"loserId\":\"$LID\"}")
chk "manager cannot merge customers" "$MANAGER_MERGE" "403"
OWNER_MERGE=$(c -b "$O" -X POST "$B/api/customers/merge" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(key)" -d "{\"winnerId\":\"$CID\",\"loserId\":\"$LID\"}")
chk "owner merges a duplicate" "$OWNER_MERGE" "200"
MERGED=$(node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});Promise.all([p.customer.findUnique({where:{id:'$CID'}}),p.customer.findUnique({where:{id:'$LID'}}),p.auditLog.count({where:{entityId:'$CID',action:'MERGE'}})]).then(([w,l,a])=>{console.log([w.marbleBalance,w.ticketBalance,l.isActive,l.mergedIntoId===w.id,a].join(','));return p.\$disconnect()})")
chk "merge moved balances, deactivated loser and audited" "$MERGED" "36,560,false,true,1"

NODE_ENV=production ./node_modules/.bin/tsx --env-file=.env scripts/reconcile-balances.ts >"$D/reconcile-final.json"
FINAL_ZERO=$(node -pe "JSON.parse(require('fs').readFileSync('$D/reconcile-final.json','utf8')).corrected")
chk "final reconciliation reports zero drift" "$FINAL_ZERO" "0"

printf "\n"
if [ "$FAILED" = 0 ]; then
  printf "\033[32mPhase 3 PASS\033[0m\n"
  exit 0
fi
printf "\033[31mPhase 3 FAIL\033[0m\n"
exit 1
