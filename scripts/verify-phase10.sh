#!/bin/bash
# Phase 10 acceptance: polish, the remaining §9 report screens, PWA (§16, §8.11).
#
# Needs the dev server on localhost:5050, the Phase 8 test accounts and the
# demo dataset (`npm run db:seed -- --demo`) so the reports have rows.
#
# §16's Phase 10 line is "responsive pass on real devices, loading and empty
# states, error copy in plain language, printable receipts, PWA manifest, then
# a one-branch pilot". Two of those cannot be closed from a shell:
#
#   - the responsive pass on REAL DEVICES, and
#   - the one-branch PILOT
#
# ...and "printable receipts" is deliberately NOT built: CLAUDE.md's
# do-not-reopen table says "No receipt printing in v1 — on-screen confirmation
# only", which wins over §16's line. See the BUILD-LOG.
#
# This script READS ONLY. It creates no rows and is safe to re-run.
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

# D-43: an empty actual almost always means the command errored rather than
# genuinely returning "". A check that passes because it crashed is worse than
# no check at all.
chk() {
  if [ -z "$2" ] && [ -n "$3" ]; then fail "$1" "<empty — command failed?>"; return; fi
  [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"
}
has() { case "$2" in *"$3"*) pass "$1";; *) fail "$1" "missing: $3";; esac; }
hasnt() { case "$2" in *"$3"*) fail "$1" "LEAKED: $3";; *) pass "$1";; esac; }

login() {
  j -c "$3" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}
q() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1 ?? ''"; }

OWNER_PASSWORD=${OWNER_PASSWORD:-'Phase8Owner2026!'}
MGR_PASSWORD=${MGR_PASSWORD:-'P8MgrPass2026!x'}
PURCH_PASSWORD=${PURCH_PASSWORD:-'P8PurPass2026!x'}
STAFF_PASSWORD=${STAFF_PASSWORD:-'P8StfPass2026!x'}

RANGE="from=2026-06-10&to=2026-08-08"

printf "════ Phase 10 setup ════\n"
login owner   "$OWNER_PASSWORD" "$O"
login p8mgr   "$MGR_PASSWORD"   "$M"
login p8purch "$PURCH_PASSWORD" "$P"
login p8staff "$STAFF_PASSWORD" "$S"

# Every actor needs a work session for the CURRENT business day or the app
# redirects them to /select-shop (§4.7) — which would make every page check
# below report 307 and look like a permission bug.
for jar in "$O" "$M" "$P" "$S"; do
  SHOP=$(j -b "$jar" "$B/api/auth/me" | q ".user.defaultShopId")
  [ -n "$SHOP" ] && j -b "$jar" -c "$jar" -X POST "$B/api/work-session" \
    -H 'Content-Type: application/json' -d "{\"shopId\":\"$SHOP\"}" >/dev/null
done
chk "owner session works" "$(c -b "$O" "$B/api/reports/sales?$RANGE")" "200"

printf "\n════ §9 · the seven new report screens render ════\n"
for p in sales-by-staff sales-by-shop payment-methods prize-redemption expenses; do
  chk "OWNER 200 on /reports/$p" "$(c -b "$O" "$B/reports/$p")" "200"
done
chk "OWNER 200 on /reports/customers"  "$(c -b "$O" "$B/reports/customers")" "200"
chk "OWNER 200 on /reports/shrinkage"  "$(c -b "$O" "$B/reports/shrinkage")" "200"

printf "\n════ §7.8 · every screen has a JSON report behind it ════\n"
# A screen whose API 404s is a screen nobody can script against, and it is how
# the next person wiring up an export discovers the name does not exist.
for r in sales-by-staff sales-by-shop shrinkage prize-redemption expenses customers; do
  chk "GET /api/reports/$r" "$(c -b "$O" "$B/api/reports/$r?$RANGE")" "200"
done

printf "\n════ §3.4 / §7.5 · the permission matrix ════\n"
chk "STAFF   403 on shrinkage"        "$(c -b "$S" "$B/api/reports/shrinkage?$RANGE")" "403"
chk "STAFF   403 on prize-redemption" "$(c -b "$S" "$B/api/reports/prize-redemption?$RANGE")" "403"
chk "STAFF   403 on customers"        "$(c -b "$S" "$B/api/reports/customers?$RANGE")" "403"
chk "plain MANAGER 403 on shrinkage"  "$(c -b "$M" "$B/api/reports/shrinkage?$RANGE")" "403"
chk "plain MANAGER 403 on customers"  "$(c -b "$M" "$B/api/reports/customers?$RANGE")" "403"
chk "MANAGER 200 on prize-redemption" "$(c -b "$M" "$B/api/reports/prize-redemption?$RANGE")" "200"

# D-34: when a permission depends on whether a parameter is PRESENT, test both
# forms. One branch passing says nothing about the other.
PURCH_SHOP=$(j -b "$P" "$B/api/auth/me" | q ".user.defaultShopId")
chk "PURCHASING 200 on shrinkage, scoped to their shop" \
  "$(c -b "$P" "$B/api/reports/shrinkage?$RANGE&shopId=$PURCH_SHOP")" "200"
chk "PURCHASING 200 on shrinkage, UNSCOPED" \
  "$(c -b "$P" "$B/api/reports/shrinkage?$RANGE")" "200"
chk "PURCHASING still 403 on profit"   "$(c -b "$P" "$B/api/reports/profit?$RANGE")" "403"
chk "PURCHASING still 403 on customers" "$(c -b "$P" "$B/api/reports/customers?$RANGE")" "403"

printf "\n════ §7.5 · cost is withheld as NULL, never as a wrong zero ════\n"
MGR_JSON=$(j -b "$M" "$B/api/reports/prize-redemption?$RANGE")
OWNER_JSON=$(j -b "$O" "$B/api/reports/prize-redemption?$RANGE")
chk "manager totalCogs is null" "$(printf '%s' "$MGR_JSON" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.totalCogs === null ? 'null' : String(d.totalCogs)")" "null"
chk "manager per-item cogs is null" "$(printf '%s' "$MGR_JSON" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.byItem.length === 0 ? 'no-rows' : (d.byItem.every(r=>r.cogs===null) ? 'null' : 'LEAK')")" "null"
chk "owner DOES get a cost figure" "$(printf '%s' "$OWNER_JSON" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.totalCogs !== null && d.totalCogs !== '0' ? 'yes' : 'no'")" "yes"
# The manager still gets the ACTIVITY — withholding cost must not withhold the
# operational numbers they need to restock.
chk "manager still sees redemption activity" "$(printf '%s' "$MGR_JSON" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.redemptions > 0 && d.ticketsSpent > 0 ? 'yes' : 'no'")" "yes"

printf "\n════ §15 · no cost value in a manager's CSV or HTML ════\n"
MGR_CSV=$(j -b "$M" "$B/api/reports/prize-redemption/export?$RANGE")
OWNER_CSV=$(j -b "$O" "$B/api/reports/prize-redemption/export?$RANGE")
has   "owner CSV HAS the cost column"      "$(printf '%s' "$OWNER_CSV" | head -1)" "Prize cost"
hasnt "manager CSV has NO cost column"     "$(printf '%s' "$MGR_CSV" | head -1)" "Prize cost"
hasnt "manager CSV has no 'cogs' anywhere" "$MGR_CSV" "cogs"
chk   "shrinkage CSV 403 for a plain manager" \
  "$(c -b "$M" "$B/api/reports/shrinkage/export?$RANGE")" "403"
chk   "shrinkage CSV 200 for owner" "$(c -b "$O" "$B/api/reports/shrinkage/export?$RANGE")" "200"
# The real figures, searched for by value in the manager's rendered page.
OWNER_COGS=$(printf '%s' "$OWNER_JSON" | q ".totalCogs")
MGR_HTML=$(j -b "$M" "$B/reports/prize-redemption")
hasnt "owner's cost figure is absent from the manager's page" "$MGR_HTML" "$OWNER_COGS"

printf "\n════ §9 · shrinkage keeps its two causes apart ════\n"
SHR=$(j -b "$O" "$B/api/reports/shrinkage?$RANGE")

# The demo dataset contains OPNAME_LOSS movements and no DAMAGE ones, so a
# mutation that misfiles damage as opname loss is INVISIBLE to any check that
# only inspects totals — and the totals check below stays green under it,
# because a reclassification does not change a sum. That is D-69's trap: a
# green result under mutation means either a weak check or a fixture that
# cannot express the bug, and you cannot tell which without looking.
#
# So this check reads the DATABASE for what each cause should be, and compares
# the API's split against it. It is honest about the fixture: if a future seed
# adds DAMAGE rows, this starts covering the other half automatically.
DB_SPLIT=$(node -e '
  const {PrismaClient}=require("@prisma/client");
  (async()=>{
    const p=new PrismaClient();
    const rows=await p.stockConsumption.findMany({
      where:{movement:{type:{in:["OPNAME_LOSS","DAMAGE"]},
        businessDate:{gte:new Date("2026-06-10"),lte:new Date("2026-08-08")}}},
      select:{qty:true,unitCogsAtConsumption:true,movement:{select:{type:true}}}});
    let o=0,d=0;
    for(const r of rows){
      const v=Number(r.unitCogsAtConsumption)*r.qty;
      if(r.movement.type==="DAMAGE") d+=v; else o+=v;
    }
    console.log(`${o.toFixed(0)}|${d.toFixed(0)}`);
    await p.$disconnect();
  })();' 2>/dev/null)
API_SPLIT=$(printf '%s' "$SHR" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  Number(d.opnameLoss).toFixed(0)+'|'+Number(d.damage).toFixed(0)")
chk "the opname/damage split matches the database exactly" "$API_SPLIT" "$DB_SPLIT"
chk "opnameLoss + damage = totalShrinkage" "$(printf '%s' "$SHR" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  // String compare via Number is safe here only because we compare a SUM to a
  // SUM of the same two values; no rounding is introduced.
  (Number(d.opnameLoss)+Number(d.damage)).toFixed(2) === Number(d.totalShrinkage).toFixed(2) ? 'ok':'MISMATCH'")" "ok"
has "shrinkage reports a per-item breakdown" "$(printf '%s' "$SHR" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.byItem.length ? 'rows' : 'none'")" "rows"
has "shrinkage reports a per-shop breakdown" "$(printf '%s' "$SHR" | node -pe "
  const d=JSON.parse(require('fs').readFileSync(0,'utf8'));
  d.byShop.length ? 'rows' : 'none'")" "rows"
# Prizes handed to customers must NEVER appear as shrinkage (§9: "mixing it
# into prize expense hides theft" — the same argument in reverse).
PE=$(j -b "$O" "$B/api/reports/prize-expense?$RANGE")
chk "prize expense and shrinkage are different numbers" "$(node -pe "
  const a=$(printf '%s' "$PE" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).prizeExpense");
  const b=$(printf '%s' "$SHR" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).totalShrinkage");
  a === b ? 'SAME' : 'different'")" "different"

printf "\n════ §8.11 · the PWA manifest ════\n"
MAN=$(j "$B/manifest.webmanifest")
chk "manifest is served"           "$(c "$B/manifest.webmanifest")" "200"
has "manifest names the app"       "$MAN" '"name":"Marblehouse"'
has "manifest is standalone"       "$MAN" '"display":"standalone"'
has "manifest has a maskable icon" "$MAN" '"purpose":"maskable"'
chk "icon.svg is served"           "$(c "$B/icon.svg")" "200"
chk "icon-maskable.svg is served"  "$(c "$B/icon-maskable.svg")" "200"
LOGIN_HTML=$(j "$B/login")
has "the page links the manifest"  "$LOGIN_HTML" 'rel="manifest"'
has "iOS gets an apple-touch-icon" "$LOGIN_HTML" 'apple-touch-icon'

printf "\n════ §16 · plain-language error copy ════\n"
# Requested WITH a session on purpose. Unauthenticated, middleware redirects
# every unknown path to /login before routing ever reaches the 404 — so the
# anonymous form tests the redirect, not the page.
NF=$(j -b "$O" "$B/definitely-not-a-real-page")
chk "an unknown page 404s"          "$(c -b "$O" "$B/definitely-not-a-real-page")" "404"
has "404 copy is plain language"    "$NF" "That page is not here"
hasnt "404 copy avoids jargon"      "$NF" "This page could not be found"
FORBIDDEN_HTML=$(j -b "$S" "$B/reports/profit")
has "403 copy explains what to do"  "$FORBIDDEN_HTML" "ask the owner"

printf "\n════ the reports index offers the right screens per role ════\n"
IDX_O=$(j -b "$O" "$B/reports")
IDX_M=$(j -b "$M" "$B/reports")
IDX_P=$(j -b "$P" "$B/reports")
has   "owner is offered Shrinkage"              "$IDX_O" '/reports/shrinkage'
has   "owner is offered the Customer leaderboard" "$IDX_O" '/reports/customers'
hasnt "plain manager is NOT offered Shrinkage"  "$IDX_M" '/reports/shrinkage'
hasnt "plain manager is NOT offered Customers"  "$IDX_M" '/reports/customers'
# D-34 in its "hidden" form: a Purchasing manager IS entitled to shrinkage, so
# hiding it from them would be the same bug as 403ing them.
has  "PURCHASING manager IS offered Shrinkage"  "$IDX_P" '/reports/shrinkage'
has  "everyone privileged is offered Sales by Staff" "$IDX_M" '/reports/sales-by-staff'

printf "\n"
if [ "$FAILED" = "0" ]; then
  printf "\033[32m════ Phase 10 PASS ════\033[0m\n"
else
  printf "\033[31m════ Phase 10 FAIL ════\033[0m\n"
fi
rm -rf "$D"
exit "$FAILED"
