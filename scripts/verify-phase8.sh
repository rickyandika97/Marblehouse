#!/bin/bash
# Phase 8 acceptance: dashboards and reports (PRD §8.3, §8.4, §9, §16).
#
# Needs the dev server on localhost:5050 and the DEMO DATASET:
#
#     npm run db:seed -- --demo
#
# §16 accepts Phase 8 on one thing:
#
#   "every metric in §9 matches a hand-calculation against the demo dataset"
#
# This script IS that hand-calculation, mechanised: every figure the API
# reports is recomputed here by INDEPENDENT SQL that does not go through
# `services/reports.ts`, and the two must agree exactly. A test that called the
# engine to check the engine would prove nothing.
#
# ── One trap this script exists to remember ──────────────────────────────────
# `businessDate` is a Postgres DATE. Binding a JS Date to it sends a
# timestamptz, and the comparison silently shifts the boundary — during Phase 8
# that dropped a whole day from a "verification" total and made the ENGINE look
# wrong when the CHECK was wrong. Every query below uses DATE LITERALS
# ('2026-06-10'), never a JS Date. Do not "tidy" that.
#
# Also: no cost value may appear in any plain-manager or staff response, on any
# endpoint INCLUDING CSV exports and error payloads (§15).
set -u
cd "$(dirname "$0")/.." || exit 1

B=http://localhost:5050
D=$(mktemp -d)
O=$D/owner.txt; M=$D/mgr.txt; P=$D/purch.txt; S=$D/staff.txt
FAILED=0

j() { curl -sS "$@"; }
c() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }

# An empty actual almost always means the query errored rather than genuinely
# returning "" — treat it as a failure (D-43). This guard caught a real false
# pass in Phase 7 and again while writing this script.
chk() {
  if [ -z "$2" ] && [ -n "$3" ]; then fail "$1" "<empty — query failed?>"; return; fi
  [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"
}

login() {
  j -c "$3" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}
q() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1 ?? ''"; }
# Raw SQL, so the check is independent of Prisma's query building too.
sql() { node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{const r=await p.\$queryRawUnsafe(\`$1\`);console.log(r[0]?Object.values(r[0])[0]:'')}finally{await p.\$disconnect()}})()"; }

FROM=${FROM:-$(node -pe "new Date(Date.now()-59*864e5).toISOString().slice(0,10)")}
TO=${TO:-$(node -pe "new Date().toISOString().slice(0,10)")}
Q="from=$FROM&to=$TO"

printf "════ Phase 8 setup ════\n"
printf "  window: %s → %s\n" "$FROM" "$TO"

login owner "${OWNER_PASSWORD:-Phase8Owner2026!}" "$O"
login p8mgr "${MGR_PASSWORD:-P8MgrPass2026!x}" "$M"
login p8purch "${PURCH_PASSWORD:-P8PurPass2026!x}" "$P"
login p8staff "${STAFF_PASSWORD:-P8StfPass2026!x}" "$S"

ME=$(j -b "$O" "$B/api/auth/me" | q ".user.role")
chk "owner session is live" "$ME" "OWNER"

DEMO_SHOPS=$(sql "SELECT COUNT(*)::text FROM \"Shop\" WHERE code LIKE 'DEMO-%'")
if [ "$DEMO_SHOPS" = "0" ] || [ -z "$DEMO_SHOPS" ]; then
  printf "\n  \033[31mNo demo data found.\033[0m Run: npm run db:seed -- --demo\n\n"
  exit 1
fi
pass "demo dataset present ($DEMO_SHOPS branches)"

# ═════════════════════════════════════════════════════════════════════════
printf "\n════ §16 THE ACCEPTANCE CRITERION — every §9 metric vs independent SQL ════\n"
# ═════════════════════════════════════════════════════════════════════════

PROFIT=$(j -b "$O" "$B/api/reports/profit?$Q")
SALES=$(j -b "$O" "$B/api/reports/sales?$Q")
LIAB=$(j -b "$O" "$B/api/reports/liability?$Q")
VAL=$(j -b "$O" "$B/api/reports/stock-valuation?$Q")

# ── Revenue: SUM(amount) WHERE status=COMPLETED, by businessDate (§9) ──
API_REV=$(printf '%s' "$SALES" | q ".summary.revenue")
SQL_REV=$(sql "SELECT COALESCE(SUM(amount),0)::text FROM \"Sale\" WHERE status='COMPLETED' AND \"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Revenue matches independent SQL" "$API_REV" "${SQL_REV%.00}"

# A voided sale must NOT be counted — proven by including them and differing.
SQL_ALL=$(sql "SELECT COALESCE(SUM(amount),0)::text FROM \"Sale\" WHERE \"businessDate\" BETWEEN '$FROM' AND '$TO'")
if [ "${SQL_ALL%.00}" = "$API_REV" ]; then
  fail "Revenue EXCLUDES voided sales" "identical to all-status total — no voids in data?"
else
  pass "Revenue excludes voided sales (all-status total differs: ${SQL_ALL%.00})"
fi

# ── Transactions / unique customers / walk-ins (§9) ──
API_TX=$(printf '%s' "$SALES" | q ".summary.transactions")
SQL_TX=$(sql "SELECT COUNT(*)::text FROM \"Sale\" WHERE status='COMPLETED' AND \"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Transactions matches" "$API_TX" "$SQL_TX"

API_UC=$(printf '%s' "$SALES" | q ".summary.uniqueCustomers")
SQL_UC=$(sql "SELECT COUNT(DISTINCT \"customerId\")::text FROM \"Sale\" WHERE status='COMPLETED' AND \"customerId\" IS NOT NULL AND \"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Unique customers matches (walk-ins excluded)" "$API_UC" "$SQL_UC"

API_WI=$(printf '%s' "$SALES" | q ".summary.walkInTransactions")
SQL_WI=$(sql "SELECT COUNT(*)::text FROM \"Sale\" WHERE status='COMPLETED' AND \"customerId\" IS NULL AND \"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Walk-in transactions counted separately" "$API_WI" "$SQL_WI"

# ── Payment split must reconcile to revenue ──
API_CASH=$(printf '%s' "$SALES" | q ".summary.cash")
API_EDC=$(printf '%s' "$SALES" | q ".summary.edc")
SPLIT_OK=$(node -pe "(Number('$API_CASH')+Number('$API_EDC'))===Number('$API_REV')?'yes':'no'")
chk "Cash + EDC reconciles to revenue" "$SPLIT_OK" "yes"

# ── Prize expense: SUM(qty × unitCogsAtConsumption) for REDEEM only (§9) ──
API_PE=$(printf '%s' "$PROFIT" | q ".combined.prizeExpense")
SQL_PE=$(sql "SELECT COALESCE(SUM(sc.qty*sc.\"unitCogsAtConsumption\"),0)::text FROM \"StockConsumption\" sc JOIN \"StockMovement\" m ON m.id=sc.\"movementId\" WHERE m.type='REDEEM' AND m.\"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Prize expense (FIFO COGS) matches" "$API_PE" "${SQL_PE%.00}"

# ── Shrinkage: the SAME sum for OPNAME_LOSS/DAMAGE, reported SEPARATELY ──
API_SH=$(printf '%s' "$PROFIT" | q ".combined.shrinkageExpense")
SQL_SH=$(sql "SELECT COALESCE(SUM(sc.qty*sc.\"unitCogsAtConsumption\"),0)::text FROM \"StockConsumption\" sc JOIN \"StockMovement\" m ON m.id=sc.\"movementId\" WHERE m.type IN ('OPNAME_LOSS','DAMAGE') AND m.\"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Shrinkage expense matches" "$API_SH" "${SQL_SH%.00}"

# §9 is explicit that mixing these hides theft. They must be different numbers.
if [ "$API_PE" = "$API_SH" ]; then
  fail "shrinkage is reported SEPARATELY from prize expense" "both = $API_PE"
else
  pass "shrinkage is separate from prize expense (theft cannot hide in COGS)"
fi

# ── Operating expenses: not-deleted only (§9) ──
API_OX=$(printf '%s' "$PROFIT" | q ".combined.operatingExpenses")
SQL_OX=$(sql "SELECT COALESCE(SUM(amount),0)::text FROM \"Expense\" WHERE \"isDeleted\"=false AND \"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Operating expenses matches (soft-deleted excluded)" "$API_OX" "${SQL_OX%.00}"

# ── Gross / net profit arithmetic ──
API_GP=$(printf '%s' "$PROFIT" | q ".combined.grossProfit")
API_NP=$(printf '%s' "$PROFIT" | q ".combined.netProfit")
GP_OK=$(node -pe "(Number('$API_REV')-Number('$API_PE')-Number('$API_SH'))===Number('$API_GP')?'yes':'no'")
NP_OK=$(node -pe "(Number('$API_GP')-Number('$API_OX'))===Number('$API_NP')?'yes':'no'")
chk "Gross profit = revenue − prize − shrinkage" "$GP_OK" "yes"
chk "Net profit = gross − operating expenses" "$NP_OK" "yes"

# Combined must equal the sum of its per-shop rows, or the screen contradicts itself.
ROWSUM_OK=$(printf '%s' "$PROFIT" | node -pe "
const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
const s=j.rows.reduce((a,r)=>a+Number(r.netProfit),0);
Math.abs(s-Number(j.combined.netProfit))<0.005?'yes':'no'")
chk "Combined total equals the sum of per-shop rows" "$ROWSUM_OK" "yes"

# ── Tickets and liability (§9) ──
API_AW=$(printf '%s' "$LIAB" | q ".ticketsAwarded")
SQL_AW=$(sql "SELECT COALESCE(SUM(delta),0)::text FROM \"TicketLedger\" WHERE type='AWARD' AND \"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Tickets awarded matches" "$API_AW" "$SQL_AW"

API_RD=$(printf '%s' "$LIAB" | q ".ticketsRedeemed")
SQL_RD=$(sql "SELECT COALESCE(ABS(SUM(delta)),0)::text FROM \"TicketLedger\" WHERE type='REDEEM' AND \"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Tickets redeemed matches, as a POSITIVE number" "$API_RD" "$SQL_RD"

API_OM=$(printf '%s' "$LIAB" | q ".outstandingMarbles")
SQL_OM=$(sql "SELECT COALESCE(SUM(\"marbleBalance\"),0)::text FROM \"Customer\" WHERE \"isActive\"=true AND \"mergedIntoId\" IS NULL")
chk "Outstanding marbles matches the cached balances" "$API_OM" "$SQL_OM"

API_OT=$(printf '%s' "$LIAB" | q ".outstandingTickets")
SQL_OT=$(sql "SELECT COALESCE(SUM(\"ticketBalance\"),0)::text FROM \"Customer\" WHERE \"isActive\"=true AND \"mergedIntoId\" IS NULL")
chk "Outstanding tickets matches the cached balances" "$API_OT" "$SQL_OT"

# Estimated liability = outstanding tickets × blended COGS per ticket (§9).
#
# The tolerance is RELATIVE, not absolute. `blendedCogsPerTicket` is displayed
# rounded to 4dp while the engine multiplies at full precision and rounds once
# at the end — which is the correct order for money. Re-multiplying the rounded
# display value therefore differs by a few rupiah in millions, and an absolute
# 0.02 tolerance flagged that as a failure when the engine was right.
LIAB_OK=$(printf '%s' "$LIAB" | node -pe "
const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
const e=Number(j.estimatedTicketLiability);
const product=Number(j.blendedCogsPerTicket)*j.outstandingTickets;
// Within one part in a million of the re-multiplied figure, or exact at zero.
(e===0&&product===0)||Math.abs(product-e)/Math.max(e,1)<1e-6?'yes':'no'")
chk "Estimated ticket liability = outstanding × blended COGS" "$LIAB_OK" "yes"

# ── Stock valuation: SUM(qtyRemaining × unitCogs) (§9) ──
API_SV=$(printf '%s' "$VAL" | q ".total")
SQL_SV=$(sql "SELECT COALESCE(SUM(\"qtyRemaining\"*\"unitCogs\"),0)::text FROM \"PrizeBatch\" WHERE \"isVoid\"=false AND \"qtyRemaining\">0")
chk "Stock valuation matches (void and empty batches excluded)" "$API_SV" "${SQL_SV%.00}"

# ── Attendance (§9 late rate) ──
ATT=$(j -b "$O" "$B/api/reports/attendance?$Q")
API_LATE=$(printf '%s' "$ATT" | q ".totals.lateCount")
SQL_LATE=$(sql "SELECT COUNT(*)::text FROM \"Attendance\" WHERE \"isLate\"=true AND \"businessDate\" BETWEEN '$FROM' AND '$TO'")
chk "Late count matches" "$API_LATE" "$SQL_LATE"

RATE_OK=$(printf '%s' "$ATT" | node -pe "
const j=JSON.parse(require('fs').readFileSync(0,'utf8'));
const t=j.totals; t.records===0?'yes':(Math.abs(t.lateCount/t.records-Number(t.lateRate))<0.0002?'yes':'no')")
chk "Late rate = late ÷ records" "$RATE_OK" "yes"

# ═════════════════════════════════════════════════════════════════════════
printf "\n════ §15 — NO cost value in any manager or staff response ════\n"
# ═════════════════════════════════════════════════════════════════════════
# Matches a cost KEY CARRYING A VALUE, not the key name alone: a key present
# and explicitly null is correct behaviour, and an earlier version of this
# check flagged three of those as leaks.
COSTVAL='"(blendedCogsPerTicket|estimatedTicketLiability|unitCogs|stockValuation|grossProfit|netProfit|prizeExpense|shrinkageExpense|totalCogs|cogsTotal)":[^n,}]'
COSTHDR='COGS|Stock value|Gross profit|Net profit|Prize expense|liability'

sweep_role() {
  local jar="$1" label="$2" expect_refused="$3"
  local r path out code body
  for r in sales customers prize-expense stock-valuation liability profit attendance low-stock; do
    for suffix in "" "/export"; do
      path="/api/reports/${r}${suffix}?${Q}"
      out=$(j -b "$jar" -w '\n%{http_code}' "$B$path") || { fail "curl failed" "$path"; return; }
      code=$(printf '%s' "$out" | tail -n1)
      body=$(printf '%s' "$out" | sed '$d')
      if [ -z "$code" ]; then fail "no status code" "$path"; continue; fi
      if [ "$code" = "200" ]; then
        if [ "$expect_refused" = "yes" ]; then
          fail "$label must be refused on $r$suffix" "200"
        elif printf '%s' "$body" | grep -qE "$COSTVAL"; then
          fail "$label leaks a cost VALUE on $r$suffix" "$(printf '%s' "$body" | grep -oE "$COSTVAL" | head -1)"
        elif [ -n "$suffix" ] && printf '%s' "$body" | head -1 | grep -qE "$COSTHDR"; then
          fail "$label leaks a cost COLUMN on $r$suffix" "$(printf '%s' "$body" | head -1)"
        fi
      fi
    done
  done
}

sweep_role "$M" "plain manager" no
pass "plain manager: no cost value or cost column on any report or export"

sweep_role "$S" "staff" yes
pass "staff: refused on every report and every export"

# A Purchasing manager MAY see cost at their own shop — but never profit.
PE_CODE=$(c -b "$P" "$B/api/reports/prize-expense?$Q")
chk "Purchasing manager reads prize expense at their shop" "$PE_CODE" "200"
PROF_CODE=$(c -b "$P" "$B/api/reports/profit?$Q")
chk "  but is still 403 on PROFIT (cost entry ≠ profitability)" "$PROF_CODE" "403"
CUST_CODE=$(c -b "$P" "$B/api/reports/customers?$Q")
chk "  and 403 on the owner customer report" "$CUST_CODE" "403"

# The liability CSV must not promise columns it cannot fill.
PLIAB_HDR=$(j -b "$P" "$B/api/reports/liability/export?$Q" | head -1)
if printf '%s' "$PLIAB_HDR" | grep -qi "COGS"; then
  fail "Purchasing liability CSV omits the owner-only valued columns" "$PLIAB_HDR"
else
  pass "Purchasing liability CSV omits the owner-only valued columns"
fi
OLIAB_HDR=$(j -b "$O" "$B/api/reports/liability/export?$Q" | head -1)
if printf '%s' "$OLIAB_HDR" | grep -qi "COGS"; then
  pass "  and the OWNER's liability CSV still carries them"
else
  fail "  and the OWNER's liability CSV still carries them" "$OLIAB_HDR"
fi

# ═════════════════════════════════════════════════════════════════════════
printf "\n════ Manager scoping — both branches of the shopId parameter (D-34) ════\n"
# ═════════════════════════════════════════════════════════════════════════
# A permission that depends on whether a parameter is PRESENT must be tested
# both ways; one branch passing says nothing about the other.

MGR_SHOP=$(j -b "$M" "$B/api/auth/me" | q ".user.defaultShopId")
UNSCOPED_SHOPS=$(j -b "$M" "$B/api/reports/sales?$Q" | q ".summary.scope.shopIds.length")
chk "UNSCOPED manager report covers exactly ONE shop" "$UNSCOPED_SHOPS" "1"

UNSCOPED_ID=$(j -b "$M" "$B/api/reports/sales?$Q" | q ".summary.scope.shopIds[0]")
chk "  and it is their own shop, not an aggregate" "$UNSCOPED_ID" "$MGR_SHOP"

ALLSHOPS=$(j -b "$M" "$B/api/reports/sales?$Q" | q ".summary.scope.isAllShops")
chk "  and isAllShops is false for a manager" "$ALLSHOPS" "false"

SCOPED_CODE=$(c -b "$M" "$B/api/reports/sales?shopId=$MGR_SHOP&$Q")
chk "EXPLICIT own shopId is accepted" "$SCOPED_CODE" "200"

OTHER_SHOP=$(sql "SELECT id FROM \"Shop\" WHERE code LIKE 'DEMO-%' AND id <> '$MGR_SHOP' LIMIT 1")
FOREIGN_CODE=$(c -b "$M" "$B/api/reports/sales?shopId=$OTHER_SHOP&$Q")
chk "EXPLICIT foreign shopId is 403 (R-4)" "$FOREIGN_CODE" "403"

OWNER_ALL=$(j -b "$O" "$B/api/reports/sales?$Q" | q ".summary.scope.isAllShops")
chk "an OWNER with no shopId gets all shops" "$OWNER_ALL" "true"

# ═════════════════════════════════════════════════════════════════════════
printf "\n════ Dashboard (§8.3, §8.4) ════\n"
# ═════════════════════════════════════════════════════════════════════════

DASH_O=$(j -b "$O" "$B/api/dashboard")
chk "owner dashboard is role-shaped OWNER" "$(printf '%s' "$DASH_O" | q '.role')" "OWNER"
chk "  carries the §8.3 liability row" "$(printf '%s' "$DASH_O" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).liability.estimatedTicketLiability!==null?'yes':'no'")" "yes"
chk "  carries the alerts panel" "$(printf '%s' "$DASH_O" | node -pe "typeof JSON.parse(require('fs').readFileSync(0,'utf8')).alerts.lowStockCount==='number'?'yes':'no'")" "yes"
chk "  flags a missing backup as stale (§8.3, red past 36h)" "$(printf '%s' "$DASH_O" | q '.alerts.backupIsStale')" "true"
chk "  30-day trend is present" "$(printf '%s' "$DASH_O" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).trend30d.length>0?'yes':'no'")" "yes"

DASH_M=$(j -b "$M" "$B/api/dashboard")
chk "manager dashboard is role-shaped MANAGER" "$(printf '%s' "$DASH_M" | q '.role')" "MANAGER"
chk "  has NO estimatedTicketLiability key at all (§8.4)" "$(printf '%s' "$DASH_M" | node -pe "('estimatedTicketLiability' in JSON.parse(require('fs').readFileSync(0,'utf8')).liability)?'present':'absent'")" "absent"
chk "  has NO stockValuation key at all (§8.4)" "$(printf '%s' "$DASH_M" | node -pe "('stockValuation' in JSON.parse(require('fs').readFileSync(0,'utf8')).liability)?'present':'absent'")" "absent"
chk "  still gets ticket QUANTITIES" "$(printf '%s' "$DASH_M" | node -pe "typeof JSON.parse(require('fs').readFileSync(0,'utf8')).liability.outstandingTickets==='number'?'yes':'no'")" "yes"

DASH_S=$(c -b "$S" "$B/api/dashboard")
chk "staff are refused the dashboard entirely (§3.4)" "$DASH_S" "403"

# ═════════════════════════════════════════════════════════════════════════
printf "\n════ Report filter UI — date range and shop picker ════\n"
# ═════════════════════════════════════════════════════════════════════════
# The filters navigate by URL, so the server re-resolves scope and permissions
# on every change. These check the CONTROL matches what the API will allow.

FIRST_SHOP=$(sql "SELECT id FROM \"Shop\" WHERE code LIKE 'DEMO-%' ORDER BY code LIMIT 1")

OWNER_SALES_HTML=$(j -b "$O" "$B/reports/sales")
chk "the filter bar renders on a report page" \
  "$(printf '%s' "$OWNER_SALES_HTML" | grep -c 'Last month')" "1"
chk "an OWNER is offered 'All shops'" \
  "$(printf '%s' "$OWNER_SALES_HTML" | grep -c 'All shops')" "1"

MGR_SALES_HTML=$(j -b "$M" "$B/reports/sales")
chk "a MANAGER gets the same presets" \
  "$(printf '%s' "$MGR_SALES_HTML" | grep -c 'Last month')" "1"
# §3.4: one shop at a time. The picker must not offer an aggregate.
chk "a MANAGER is NOT offered 'All shops' (§3.4)" \
  "$(printf '%s' "$MGR_SALES_HTML" | grep -c 'All shops')" "0"

MGR_OPTIONS=$(printf '%s' "$MGR_SALES_HTML" | grep -oE '<option value="[^"]+"' | wc -l | tr -d ' ')
chk "  and their picker lists only their assigned shops" "$MGR_OPTIONS" "1"

# The range must actually narrow the data, not just redraw the header.
REV_ALL=$(j -b "$O" "$B/api/reports/sales?$Q" | q ".summary.revenue")
REV_DAY=$(j -b "$O" "$B/api/reports/sales?from=$TO&to=$TO" | q ".summary.revenue")
if [ "$REV_ALL" = "$REV_DAY" ]; then
  fail "narrowing the date range changes the figure" "both $REV_ALL"
else
  pass "narrowing the date range changes the figure"
fi

REV_ONE_SHOP=$(j -b "$O" "$B/api/reports/sales?$Q&shopId=$FIRST_SHOP" | q ".summary.revenue")
if [ "$REV_ALL" = "$REV_ONE_SHOP" ]; then
  fail "the shop filter changes the figure" "both $REV_ALL"
else
  pass "the shop filter changes the figure"
fi

# The export must carry the filters, or the CSV silently disagrees with the
# screen — and you would not notice until the numbers were in a spreadsheet.
CSV_DAY_ROWS=$(j -b "$O" "$B/api/reports/sales/export?from=$TO&to=$TO" | tail -n +2 | grep -c "$TO")
chk "the CSV export carries the current filters" "$CSV_DAY_ROWS" "1"

# A date arrives from the URL bar and can be anything. A page has no
# handleRoute, so an unhandled throw is a 500 rather than a usable screen.
BANANA=$(c -b "$O" "$B/reports/sales?from=banana&to=$TO")
chk "a malformed date falls back instead of 500ing" "$BANANA" "200"
IMPOSSIBLE=$(c -b "$O" "$B/reports/sales?from=2026-02-31&to=$TO")
chk "an impossible calendar date falls back too" "$IMPOSSIBLE" "200"
INVERTED=$(c -b "$O" "$B/reports/sales?from=$TO&to=$FROM")
chk "an inverted range is swapped, not refused" "$INVERTED" "200"
INVERTED_HDR=$(j -b "$O" "$B/reports/sales?from=$TO&to=$FROM" | grep -oE "$FROM<!-- --> to <!-- -->$TO" | head -1)
chk "  and it renders the corrected window" \
  "$([ -n "$INVERTED_HDR" ] && echo yes)" "yes"

# A shop id that does not exist must say so, not render a calm page of zeroes.
GHOST=$(c -b "$O" "$B/reports/sales?shopId=no-such-shop")
chk "a nonexistent shopId is 404, not a silent zero" "$GHOST" "404"
# …but a MANAGER must get 403 first, so ids cannot be probed for existence.
GHOST_MGR=$(c -b "$M" "$B/reports/sales?shopId=no-such-shop")
chk "  and a MANAGER gets 403 first, so ids cannot be probed" "$GHOST_MGR" "403"

# ═════════════════════════════════════════════════════════════════════════
printf "\n════ CSV export mechanics (§7.8) ════\n"
# ═════════════════════════════════════════════════════════════════════════

CSV_CT=$(curl -sS -o /dev/null -w "%{content_type}" -b "$O" "$B/api/reports/sales/export?$Q")
chk "export returns text/csv" "$(printf '%s' "$CSV_CT" | grep -o 'text/csv')" "text/csv"

CSV_CD=$(curl -sS -D - -o /dev/null -b "$O" "$B/api/reports/sales/export?$Q" | grep -i content-disposition | tr -d '\r')
chk "export is an attachment with a filename" "$(printf '%s' "$CSV_CD" | grep -co 'attachment; filename=')" "1"

CSV_ROWS=$(j -b "$O" "$B/api/reports/sales/export?$Q" | grep -c ",")
chk "sales CSV has a header plus rows" "$([ "$CSV_ROWS" -gt 1 ] && echo yes)" "yes"

# The CSV total must equal the JSON total — one engine, two renderings.
CSV_SUM=$(j -b "$O" "$B/api/reports/sales/export?$Q" | tail -n +2 | awk -F, 'NF>1{s+=$2} END{printf "%.0f", s}')
chk "CSV revenue column sums to the JSON revenue" "$CSV_SUM" "${API_REV%.*}"

BAD_CODE=$(c -b "$O" "$B/api/reports/not-a-report/export?$Q")
chk "an unknown export name is 404, not a guess" "$BAD_CODE" "404"

# ═════════════════════════════════════════════════════════════════════════
printf "\n"
if [ $FAILED -eq 0 ]; then
  printf "\033[32m════ Phase 8 PASS ════\033[0m\n\n"
else
  printf "\033[31m════ Phase 8 FAIL ════\033[0m\n\n"
fi
rm -rf "$D"
exit $FAILED
