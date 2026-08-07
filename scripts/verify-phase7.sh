#!/bin/bash
# Phase 7 acceptance: expenses (PRD §4.12, §7.6, §16).
#
# Needs the dev server on localhost:5050 and the Phase 1 test accounts. Writes
# expense categories and expense rows to the dev database.
#
# §16 accepts Phase 7 on ONE thing:
#
#   "deleting a used category returns a clear refusal with the usage count"
#
# That is checked here at HTTP level in both directions — an unused category
# deletes, a used one comes back 409 CATEGORY_IN_USE with the count in the
# body — plus the surrounding rules that make expenses correct: HQ accepts
# expenses where a transfer would not, businessDate is server-computed, money
# survives as a string, the permission matrix holds, and a delete is soft.
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
# An empty actual almost always means the query errored rather than genuinely
# returning "" — treat it as a failure (D-43).
chk() {
  if [ -z "$2" ] && [ -n "$3" ]; then fail "$1" "<empty — query failed?>"; return; fi
  [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"
}
login() {
  j -c "$3" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}
q() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1 ?? ''"; }
db() { node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await (async(p)=>{ $1 })(p))}finally{await p.\$disconnect()}})()"; }

TS=$(date +%s)

printf "════ Phase 7 setup ════\n"
login owner OwnerRealPass2026! "$O"
login manager1 MgrRealPass2026! "$M"
login staff1 StaffRealPass2026! "$S"

SHOP=$(db "return (await p.shop.findFirst({where:{code:'BR-1'}})).id")
SHOP2=$(db "return (await p.shop.findFirst({where:{code:'BR-2'}})).id")
HQ=$(db "return (await p.shop.findFirst({where:{isHqPseudoShop:true}})).id")
for JAR in "$O" "$M" "$S"; do
  j -b "$JAR" -X POST "$B/api/work-session" -H 'Content-Type: application/json' \
    -d "{\"shopId\":\"$SHOP\"}" >/dev/null
done
printf "  shop=%s  hq=%s\n" "${SHOP:0:8}" "${HQ:0:8}"

# ═════════════════════════════════════════════════════════════════════════
printf "\n════ §16 THE ACCEPTANCE CRITERION — delete-if-unused ════\n"
# ═════════════════════════════════════════════════════════════════════════

# An UNUSED category deletes outright.
UNUSED=$(j -b "$O" -X POST "$B/api/expense-categories" -H 'Content-Type: application/json' \
  -d "{\"name\":\"P7 Unused $TS\"}" | q ".id")
chk "an unused category is created" "$([ -n "$UNUSED" ] && echo yes)" "yes"

DEL=$(c -b "$O" -X DELETE "$B/api/expense-categories/$UNUSED")
chk "deleting an UNUSED category returns 200" "$DEL" "200"

GONE=$(db "return (await p.expenseCategory.count({where:{id:'$UNUSED'}}))")
chk "  and the row is really gone" "$GONE" "0"

# A USED category refuses — with the count.
USED=$(j -b "$O" -X POST "$B/api/expense-categories" -H 'Content-Type: application/json' \
  -d "{\"name\":\"P7 Used $TS\"}" | q ".id")

for AMOUNT in 150000 250000; do
  j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(uuidgen)" \
    -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$USED\",\"amount\":\"$AMOUNT\"}" >/dev/null
done

REFUSE_BODY=$(j -b "$O" -X DELETE "$B/api/expense-categories/$USED")
REFUSE_CODE=$(c -b "$O" -X DELETE "$B/api/expense-categories/$USED")

chk "deleting a USED category returns 409" "$REFUSE_CODE" "409"
chk "  the error code is CATEGORY_IN_USE" "$(echo "$REFUSE_BODY" | q ".error.code")" "CATEGORY_IN_USE"
# THE criterion: the count is what makes the refusal actionable.
chk "  the usage COUNT is in the body" "$(echo "$REFUSE_BODY" | q ".error.details.usageCount")" "2"
MSG=$(echo "$REFUSE_BODY" | q ".error.message")
case "$MSG" in
  *"2 expenses"*) pass "  the message names the count in words" ;;
  *) fail "  the message names the count in words" "$MSG" ;;
esac

# And it must NOT have silently archived instead — that is the failure mode
# §17 calls out by name.
ARCHIVED=$(db "return (await p.expenseCategory.findUnique({where:{id:'$USED'}})).isArchived")
chk "  the refusal did NOT silently archive it" "$ARCHIVED" "false"

# Archiving is the offered alternative, and it works.
ARCH=$(c -b "$O" -X PATCH "$B/api/expense-categories/$USED" -H 'Content-Type: application/json' \
  -d '{"isArchived":true}')
chk "archiving the used category instead returns 200" "$ARCH" "200"
IN_LIST=$(j -b "$O" "$B/api/expense-categories" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).filter(c=>c.id==='$USED').length")
chk "  it drops out of the default (new-entry) list" "$IN_LIST" "0"
IN_ALL=$(j -b "$O" "$B/api/expense-categories?includeArchived=true" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).filter(c=>c.id==='$USED').length")
chk "  but is still visible to the owner's manager" "$IN_ALL" "1"
NEW_AGAINST_ARCHIVED=$(c -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$USED\",\"amount\":\"1000\"}")
chk "  and a NEW expense against it is refused (422)" "$NEW_AGAINST_ARCHIVED" "422"
j -b "$O" -X PATCH "$B/api/expense-categories/$USED" -H 'Content-Type: application/json' \
  -d '{"isArchived":false}' >/dev/null

printf "\n════ §4.12 HQ accepts expenses (where a transfer would not) ════\n"

CAT=$(j -b "$O" -X POST "$B/api/expense-categories" -H 'Content-Type: application/json' \
  -d "{\"name\":\"P7 General $TS\"}" | q ".id")

HQ_BODY=$(j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"shopId\":\"$HQ\",\"categoryId\":\"$CAT\",\"amount\":\"3000000\",\"note\":\"Head office rent\"}")
chk "an expense against HQ is accepted" "$(echo "$HQ_BODY" | q ".shop.id")" "$HQ"
chk "  and holds its amount" "$(echo "$HQ_BODY" | q ".amount")" "3000000"

# The contrast that makes it meaningful: a transfer to HQ is still refused.
HQ_TRANSFER=$(c -b "$O" -X POST "$B/api/transfers" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"fromShopId\":\"$SHOP\",\"toShopId\":\"$HQ\",\"lines\":[]}")
case "$HQ_TRANSFER" in
  2*) fail "  a transfer to HQ is still refused" "$HQ_TRANSFER" ;;
  *)  pass "  a transfer to HQ is still refused ($HQ_TRANSFER)" ;;
esac

printf "\n════ §4.1 / D-13 money ════\n"

MONEY=$(j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"1234567890.12\"}")
chk "a 12-digit amount with decimals survives exactly" "$(echo "$MONEY" | q ".amount")" "1234567890.12"
RAW=$(j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"999.99\"}")
chk "  amount crosses the wire as a STRING, not a number" \
  "$(echo "$RAW" | node -pe "typeof JSON.parse(require('fs').readFileSync(0,'utf8')).amount")" "string"

ZERO=$(c -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"0\"}")
chk "a zero amount is refused" "$ZERO" "422"
NEG=$(c -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"-500\"}")
chk "a negative amount is refused" "$NEG" "422"

printf "\n════ §4.2 / D-18 businessDate is server-computed ════\n"

BD=$(j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"5000\",\"businessDate\":\"1999-01-01\"}")
BD_DATE=$(echo "$BD" | q ".businessDate")
chk "a client-sent businessDate is ignored" "$([ "$BD_DATE" = "1999-01-01" ] && echo leaked || echo ignored)" "ignored"
TODAY=$(db "return (await p.expense.findUnique({where:{id:'$(echo "$BD" | q ".id")'}})).businessDate.toISOString().slice(0,10)")
chk "  the stored date matches what the API reported" "$BD_DATE" "$TODAY"
chk "  and the stamped date looks like a date" \
  "$(echo "$BD_DATE" | grep -cE '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')" "1"

printf "\n════ NF-5 idempotency ════\n"

KEY=$(uuidgen)
BEFORE=$(db "return (await p.expense.count({where:{categoryId:'$CAT'}}))")
ID1=$(j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"77000\"}" | q ".id")
ID2=$(j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $KEY" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"77000\"}" | q ".id")
AFTER=$(db "return (await p.expense.count({where:{categoryId:'$CAT'}}))")
chk "a replayed key returns the same expense" "$ID1" "$ID2"
chk "  and creates exactly one row" "$((AFTER - BEFORE))" "1"

printf "\n════ §3.4 permissions ════\n"

chk "STAFF cannot list expenses" "$(c -b "$S" "$B/api/expenses")" "403"
chk "STAFF cannot record an expense" \
  "$(c -b "$S" -X POST "$B/api/expenses" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"100\"}")" "403"
chk "STAFF cannot list categories" "$(c -b "$S" "$B/api/expense-categories")" "403"
chk "MANAGER cannot create a category" \
  "$(c -b "$M" -X POST "$B/api/expense-categories" -H 'Content-Type: application/json' -d '{"name":"nope"}')" "403"
chk "MANAGER cannot delete a category" \
  "$(c -b "$M" -X DELETE "$B/api/expense-categories/$CAT")" "403"
chk "MANAGER CAN record an expense at their own shop" \
  "$(c -b "$M" -X POST "$B/api/expenses" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"12000\"}")" "200"
chk "MANAGER cannot record against an unassigned shop" \
  "$(c -b "$M" -X POST "$B/api/expenses" -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuidgen)" -d "{\"shopId\":\"$SHOP2\",\"categoryId\":\"$CAT\",\"amount\":\"12000\"}")" "403"
chk "MANAGER cannot list another shop's expenses by ID" \
  "$(c -b "$M" "$B/api/expenses?shopId=$SHOP2")" "403"

# D-34's lesson: test the ABSENT-parameter branch too.
UNSCOPED=$(j -b "$M" "$B/api/expenses")
OTHER_SHOP_ROWS=$(echo "$UNSCOPED" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).expenses.filter(e=>e.shop.id!=='$SHOP').length")
chk "an UNSCOPED manager list contains no other shop's rows" "$OTHER_SHOP_ROWS" "0"

printf "\n════ §6.1.5 a delete is soft, and audited ════\n"

VICTIM=$(j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$CAT\",\"amount\":\"31000\"}" | q ".id")

chk "deleting without a reason is refused" \
  "$(c -b "$O" -X DELETE "$B/api/expenses/$VICTIM" -H 'Content-Type: application/json' -d '{}')" "422"
chk "MANAGER cannot delete an expense" \
  "$(c -b "$M" -X DELETE "$B/api/expenses/$VICTIM" -H 'Content-Type: application/json' -d '{"reason":"trying it on"}')" "403"
chk "OWNER can delete with a reason" \
  "$(c -b "$O" -X DELETE "$B/api/expenses/$VICTIM" -H 'Content-Type: application/json' -d '{"reason":"duplicate entry"}')" "200"

STILL=$(db "return (await p.expense.findUnique({where:{id:'$VICTIM'}})).isDeleted")
chk "  the row still exists, flagged deleted" "$STILL" "true"
AUDIT=$(db "return (await p.auditLog.count({where:{entity:'Expense',entityId:'$VICTIM',action:'DELETE'}}))")
chk "  an audit row records it" "$AUDIT" "1"
REASON=$(db "return (await p.auditLog.findFirst({where:{entity:'Expense',entityId:'$VICTIM',action:'DELETE'}})).reason")
chk "  with the reason" "$REASON" "duplicate entry"
GET_DELETED=$(c -b "$O" "$B/api/expenses/$VICTIM")
chk "  and it is gone from the read path" "$GET_DELETED" "404"

printf "\n════ §8.8 the list total ════\n"

TOTAL_CAT=$(j -b "$O" -X POST "$B/api/expense-categories" -H 'Content-Type: application/json' \
  -d "{\"name\":\"P7 Total $TS\"}" | q ".id")
for A in 10.50 20.25 30.25; do
  j -b "$O" -X POST "$B/api/expenses" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(uuidgen)" \
    -d "{\"shopId\":\"$SHOP\",\"categoryId\":\"$TOTAL_CAT\",\"amount\":\"$A\"}" >/dev/null
done
SUM=$(j -b "$O" "$B/api/expenses?shopId=$SHOP&categoryId=$TOTAL_CAT" | q ".total")
chk "the running total sums the filtered range exactly" "$SUM" "61"

printf "\n"
if [ "$FAILED" = "0" ]; then
  printf "\033[32m════ Phase 7 PASS ════\033[0m\n"
else
  printf "\033[31m════ Phase 7 FAIL ════\033[0m\n"
fi
rm -rf "$D"
exit "$FAILED"
