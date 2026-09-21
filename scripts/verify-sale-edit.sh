#!/bin/bash
# Owner sale editing and un-voiding (D-181).
#
# Not a phase script — the feature was added after Phase 10 — so it follows the
# shape of verify-shops.sh / verify-users.sh instead: create its own fixtures,
# assert, then delete them, so the script is re-runnable against a database
# that already has real data in it.
#
# It drives the REAL HTTP routes, not the service functions, because the thing
# most worth proving here is the permission boundary, and that boundary is only
# meaningful once a request has been through the guard. `sale-edit.test.ts`
# covers the service's invariants; this covers the wiring.
#
# Requires `npm run dev` on :5050 and a dev database.
cd "$(dirname "$0")/.." || exit 1
B=http://localhost:5050
D=$(mktemp -d)
O=$D/owner.txt; M=$D/manager.txt

# The dev accounts' shared password. Read from the environment or .env rather
# than written here: this script is committed to a PUBLIC repository, and a
# working credential in source is a bad habit even when the database it opens
# is only ever local. Override with VERIFY_PW=... if yours differs.
#
# Never reset these accounts' passwords to make this script run — change the
# variable instead.
PW="${VERIFY_PW:-$(grep -m1 '^DEV_ACCOUNT_PASSWORD' .env 2>/dev/null | cut -d= -f2- | tr -d '"')}"
if [ -z "$PW" ]; then
  echo "No password available. Set VERIFY_PW=... or add DEV_ACCOUNT_PASSWORD to .env."
  exit 1
fi

j() { curl -s "$@"; }
code() { curl -s -o /dev/null -w "%{http_code}" "$@"; }

pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
chk() { [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"; }

# A query helper, so the script asserts against the DATABASE and not only
# against what the API chose to echo back. D-43: a verification script must
# fail when its own query fails, so `-v ON_ERROR_STOP=1`.
DB=$(grep -m1 '^DATABASE_URL' .env | sed 's/^DATABASE_URL=//; s/^"//; s/"$//')
# `head -1` because an INSERT ... RETURNING prints the value and then psql's
# own command tag; taking both turned every fixture id into "id\nINSERT 0 1",
# which then failed a foreign key with a very confusing message.
q() { psql -v ON_ERROR_STOP=1 -tAc "$1" "$DB" | head -1; }

case "$DB" in
  *_dev*|*_test*) ;;
  *) echo "Refusing to run: DATABASE_URL is not a _dev/_test database."; exit 1 ;;
esac

echo "════ 0. Fixtures ════"

STAMP=$(date +%H%M%S)
SHOP_A=$(q "INSERT INTO \"Shop\" (id, code, name, timezone, \"allowCustomAmount\", \"updatedAt\")
            VALUES ('se-a-$STAMP', 'SEA-$STAMP', 'SaleEdit A $STAMP', 'Asia/Jakarta', true, now())
            RETURNING id;")
SHOP_B=$(q "INSERT INTO \"Shop\" (id, code, name, timezone, \"allowCustomAmount\", \"updatedAt\")
            VALUES ('se-b-$STAMP', 'SEB-$STAMP', 'SaleEdit B $STAMP', 'Asia/Jakarta', true, now())
            RETURNING id;")
PRESET_A=$(q "INSERT INTO \"SalePreset\" (id, \"shopId\", label, amount, \"sortOrder\")
              VALUES ('se-p-$STAMP', '$SHOP_A', 'Rp 50.000', 50000, 0)
              RETURNING id;")
PRESET_B=$(q "INSERT INTO \"SalePreset\" (id, \"shopId\", label, amount, \"sortOrder\")
              VALUES ('se-pb-$STAMP', '$SHOP_B', 'Rp 99.000', 99000, 0)
              RETURNING id;")
[ -n "$SHOP_A" ] && [ -n "$PRESET_A" ] && pass "two branches and their price lists created" \
  || fail "two branches and their price lists created" "$SHOP_A/$PRESET_A"

OWNER_ID=$(q "SELECT id FROM \"user\" WHERE username='owner';")
MANAGER_ID=$(q "SELECT id FROM \"user\" WHERE username='manager';")

# The manager needs MANAGER at shop A to be a fair test of the permission: a
# refusal has to be because they are not the OWNER, not because they cannot
# reach the shop at all.
q "INSERT INTO \"UserShop\" (id, \"userId\", \"shopId\", role, \"canEnterCost\")
   VALUES ('se-us-$STAMP', '$MANAGER_ID', '$SHOP_A', 'MANAGER', false)
   ON CONFLICT DO NOTHING;" >/dev/null

cleanup() {
  # The fixture branches are about to disappear. Any work session still
  # pointing at one would strand that account on a shop that no longer exists,
  # so those rows go first — the accounts simply re-pick on their next visit.
  q "DELETE FROM \"AuditLog\" WHERE \"shopId\" IN ('$SHOP_A','$SHOP_B');" >/dev/null
  q "DELETE FROM \"Sale\" WHERE \"shopId\" IN ('$SHOP_A','$SHOP_B');" >/dev/null
  q "DELETE FROM \"SalePreset\" WHERE \"shopId\" IN ('$SHOP_A','$SHOP_B');" >/dev/null
  q "DELETE FROM \"WorkSession\" WHERE \"shopId\" IN ('$SHOP_A','$SHOP_B');" >/dev/null
  q "DELETE FROM \"UserShop\" WHERE \"shopId\" IN ('$SHOP_A','$SHOP_B');" >/dev/null
  q "DELETE FROM \"Shop\" WHERE id IN ('$SHOP_A','$SHOP_B');" >/dev/null
  rm -rf "$D"
}
trap cleanup EXIT

echo "════ 1. Sign in and record a sale to edit ════"

j -c $O -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"owner\",\"password\":\"$PW\"}" > $D/login.json
grep -q landingPath $D/login.json && pass "owner signed in" \
  || fail "owner signed in" "$(cat $D/login.json)"

# POST creates today's session; PATCH switches it. Both are needed because the
# owner may already have picked a shop today, and `setWorkSession` is
# idempotent rather than a switch — POST alone silently left the session on
# whatever branch it was already on, and the sale then failed with "that price
# is not available at this shop", which reads as a preset bug rather than a
# fixture one.
j -b $O -c $O -X POST $B/api/work-session -H 'Content-Type: application/json' \
  -d "{\"shopId\":\"$SHOP_A\"}" >/dev/null
j -b $O -c $O -X PATCH $B/api/work-session -H 'Content-Type: application/json' \
  -d "{\"shopId\":\"$SHOP_A\",\"reason\":\"verify-sale-edit fixture\"}" >/dev/null

SALE=$(j -b $O -X POST $B/api/sales -H 'Content-Type: application/json' \
  -H "Idempotency-Key: se-$STAMP-1" \
  -d "{\"presetId\":\"$PRESET_A\",\"paymentMethod\":\"CASH\"}" \
  | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$SALE" ]; then
  pass "a Rp 50.000 cash sale was recorded"
else
  # Everything below acts on this id. Continuing would run 25 checks against
  # `/api/sales/`, whose trailing-slash 308 reads as a permission bug that is
  # not there — noise that hides the one real failure (D-96).
  fail "a Rp 50.000 cash sale was recorded" "no id returned"
  echo "Cannot continue without a sale to edit."
  exit 1
fi

echo "════ 2. Only the owner may edit (§3.4) ════"

j -c $M -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d "{\"username\":\"manager\",\"password\":\"$PW\"}" >/dev/null
j -b $M -c $M -X POST $B/api/work-session -H 'Content-Type: application/json' \
  -d "{\"shopId\":\"$SHOP_A\"}" >/dev/null
j -b $M -c $M -X PATCH $B/api/work-session -H 'Content-Type: application/json' \
  -d "{\"shopId\":\"$SHOP_A\",\"reason\":\"verify-sale-edit fixture\"}" >/dev/null

chk "MANAGER editing a sale at their OWN shop is 403" \
  "$(code -b $M -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
      -d '{"amount":1,"reason":"manager attempt"}')" "403"

chk "MANAGER restoring a void is 403 (a separate branch)" \
  "$(code -b $M -X POST $B/api/sales/$SALE/unvoid -H 'Content-Type: application/json' \
      -d '{"reason":"manager attempt"}')" "403"

chk "MANAGER cannot reach the All Sales screen" \
  "$(code -b $M $B/sales)" "403"

chk "OWNER can reach the All Sales screen" \
  "$(code -b $O $B/sales)" "200"

echo "════ 3. A reason is mandatory ════"

chk "an edit with no reason is refused" \
  "$(code -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
      -d '{"amount":60000}')" "422"

chk "an edit with a two-character reason is refused" \
  "$(code -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
      -d '{"amount":60000,"reason":"no"}')" "422"

echo "════ 4. The edit itself ════"

j -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
  -d '{"amount":65000,"paymentMethod":"EDC","reason":"counted the till"}' > $D/edit.json

chk "amount changed to 65000, as an exact string" \
  "$(grep -o '"amount":"[^"]*"' $D/edit.json | cut -d'"' -f4)" "65000"
chk "payment method changed to EDC" \
  "$(grep -o '"paymentMethod":"[^"]*"' $D/edit.json | cut -d'"' -f4)" "EDC"
chk "the database agrees (not just the response)" \
  "$(q "SELECT amount FROM \"Sale\" WHERE id='$SALE';")" "65000.00"
chk "switching off a preset marks it a custom amount" \
  "$(q "SELECT \"isCustomAmount\" FROM \"Sale\" WHERE id='$SALE';")" "t"

echo "════ 5. Moving the date moves the reporting day (§4.2, D-18) ════"

# 14:00 Jakarta on 18 Sep 2026 = 07:00 UTC — after the 04:00 cutoff, so the
# 18th.
j -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
  -d '{"occurredAt":"2026-09-18T07:00:00.000Z","reason":"keyed in on the wrong day"}' > $D/date.json
chk "businessDate follows occurredAt" \
  "$(q "SELECT \"businessDate\" FROM \"Sale\" WHERE id='$SALE';")" "2026-09-18"

# 22:00 UTC on 18 Sep = 05:00 JAKARTA on the 19th, past the cutoff. Truncating
# the UTC timestamp would say the 18th — the bug this case exists to catch.
j -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
  -d '{"occurredAt":"2026-09-18T22:00:00.000Z","reason":"timezone is the shop'"'"'s"}' >/dev/null
chk "the instant is resolved in the SHOP's timezone, not UTC" \
  "$(q "SELECT \"businessDate\" FROM \"Sale\" WHERE id='$SALE';")" "2026-09-19"

chk "a future date is refused" \
  "$(code -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
      -d "{\"occurredAt\":\"2099-01-01T00:00:00.000Z\",\"reason\":\"should be refused\"}")" "422"

echo "════ 6. Moving the shop (§4.12, D-15) ════"

chk "another branch's preset is refused" \
  "$(code -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
      -d "{\"presetId\":\"$PRESET_B\",\"reason\":\"wrong branch's price list\"}")" "404"

HQ=$(q "SELECT id FROM \"Shop\" WHERE \"isHqPseudoShop\" = true LIMIT 1;")
if [ -n "$HQ" ]; then
  chk "a move onto HQ is refused" \
    "$(code -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
        -d "{\"shopId\":\"$HQ\",\"reason\":\"HQ takes no sales\"}")" "422"
else
  printf "  \033[33m•\033[0m %s\n" "a move onto HQ is refused  (SKIPPED — no HQ shop in this database)"
fi

j -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
  -d "{\"shopId\":\"$SHOP_B\",\"reason\":\"rung up at the wrong branch\"}" >/dev/null
chk "the sale moved to branch B" \
  "$(q "SELECT \"shopId\" FROM \"Sale\" WHERE id='$SALE';")" "$SHOP_B"
chk "and the amount came with it" \
  "$(q "SELECT amount FROM \"Sale\" WHERE id='$SALE';")" "65000.00"

echo "════ 7. Re-attributing to another staff member (§9) ════"

chk "someone who does not work at that shop is refused" \
  "$(code -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
      -d "{\"recordedById\":\"$MANAGER_ID\",\"reason\":\"not at branch B\"}")" "422"

j -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
  -d "{\"recordedById\":\"$OWNER_ID\",\"reason\":\"I rang it up myself\"}" >/dev/null
chk "the OWNER is accepted despite holding no UserShop row (D-122)" \
  "$(q "SELECT \"recordedById\" FROM \"Sale\" WHERE id='$SALE';")" "$OWNER_ID"

echo "════ 8. Void, refuse-to-edit, restore (D-181) ════"

j -b $O -X POST $B/api/sales/$SALE/void -H 'Content-Type: application/json' \
  -d '{"reason":"voided to test the restore"}' >/dev/null
chk "the sale is voided" "$(q "SELECT status FROM \"Sale\" WHERE id='$SALE';")" "VOIDED"

chk "editing a VOIDED sale is refused with SALE_NOT_EDITABLE" \
  "$(code -b $O -X PATCH $B/api/sales/$SALE -H 'Content-Type: application/json' \
      -d '{"amount":5000,"reason":"should be refused"}')" "409"

j -b $O -X POST $B/api/sales/$SALE/unvoid -H 'Content-Type: application/json' \
  -d '{"reason":"that void was the mistake"}' >/dev/null
chk "the sale is restored to COMPLETED" \
  "$(q "SELECT status FROM \"Sale\" WHERE id='$SALE';")" "COMPLETED"
chk "and the void metadata is cleared" \
  "$(q "SELECT coalesce(\"voidReason\",'(null)') FROM \"Sale\" WHERE id='$SALE';")" "(null)"

chk "restoring a sale that is not voided is refused" \
  "$(code -b $O -X POST $B/api/sales/$SALE/unvoid -H 'Content-Type: application/json' \
      -d '{"reason":"nothing to restore"}')" "409"

echo "════ 9. The audit trail (§4.16) ════"

chk "every edit wrote an UPDATE row" \
  "$(q "SELECT count(*) > 0 FROM \"AuditLog\"
        WHERE entity='Sale' AND \"entityId\"='$SALE' AND action='UPDATE';")" "t"
chk "the VOID row survived the restore" \
  "$(q "SELECT count(*) FROM \"AuditLog\"
        WHERE entity='Sale' AND \"entityId\"='$SALE' AND action='VOID';")" "1"
chk "the restore wrote its own UNVOID row" \
  "$(q "SELECT count(*) FROM \"AuditLog\"
        WHERE entity='Sale' AND \"entityId\"='$SALE' AND action='UNVOID';")" "1"
chk "an UPDATE row carries the reason it was given" \
  "$(q "SELECT reason FROM \"AuditLog\"
        WHERE entity='Sale' AND \"entityId\"='$SALE' AND action='UPDATE'
        ORDER BY \"occurredAt\" LIMIT 1;")" "counted the till"
chk "money is a STRING in the before snapshot, never a float (D-13)" \
  "$(q "SELECT before->>'amount' FROM \"AuditLog\"
        WHERE entity='Sale' AND \"entityId\"='$SALE' AND action='UPDATE'
        ORDER BY \"occurredAt\" LIMIT 1;")" "50000"
chk "the after snapshot holds the new figure" \
  "$(q "SELECT after->>'amount' FROM \"AuditLog\"
        WHERE entity='Sale' AND \"entityId\"='$SALE' AND action='UPDATE'
        ORDER BY \"occurredAt\" LIMIT 1;")" "65000"

echo
if [ -n "$FAILED" ]; then
  printf "\033[31m✗ verify-sale-edit FAILED\033[0m\n"; exit 1
else
  printf "\033[32m✓ verify-sale-edit — all checks passed\033[0m\n"
fi
