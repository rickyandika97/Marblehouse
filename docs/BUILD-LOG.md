# Build log — decisions made during construction

**Read this after `CLAUDE.md` and before `docs/PRD.md`.**

The PRD is the specification. This file records what was actually built and
every decision taken that the PRD does not contain or now contradicts. Where
this file and the PRD disagree, **this file wins** — it was written later, with
the code in front of it.

**Update this file before calling any phase finished** — item 6 of *Before
finishing any phase* in `CLAUDE.md` lists exactly what to write. Append; do not
rewrite history. A superseded decision gets a new entry saying what changed and
why, not an edit to the old one.

---

## Phase status

| Phase | Scope | Status |
|---|---|:--:|
| 0 | Scaffold, schema, seed, health endpoint | ✅ Done |
| 1 | Auth, roles, work session, app shell | ✅ Done — all §16 criteria verified |
| 2 | Sales + customers | ✅ Done — all §16 criteria verified |
| 3 | Marble & ticket ledgers | ✅ Done — all §16 criteria verified |
| 4 | Prizes, FIFO inventory, redemption | 🟨 Built + verified on dev — awaiting the on-device acceptance pass |
| 5 | Transfers and opname | ⬜ |
| 6 | Attendance | ⬜ |
| 7 | Expenses | ⬜ |
| 8 | Dashboards and reports | ⬜ |
| 9 | Backup, restore, hardening | ⬜ |
| 10 | Polish and pilot | ⬜ |

---

## PRD reconciliation

The PRD was edited mid-build and §6 briefly contradicted §5.4. **This was fixed
at the end of Phase 1** — §6's `User`, `Session`, `Account` and `Verification`
models were rewritten to match what was built, and verified field-for-field
against `prisma/schema.prisma`.

**`prisma/schema.prisma` remains the authority.** If the two ever drift again,
the code wins, and §6 should be corrected rather than the code.

### Things that look wrong in the schema but are deliberate

| Looks like a bug | Actually | See |
|---|---|---|
| `user.email` holds fake `.invalid` addresses | Required by the library; the business collects no email | D-1 |
| No `isActive` on `User`, but `banned` instead | `banned` is the single access flag; `isActive` is derived in the DTO | D-2 |
| `username` can't be edited anywhere | Immutable by design — it seeds the synthetic email | D-3 |
| User creation bypasses `auth.api.createUser` | That endpoint is plugin-gated and 403s for us | D-4 |
| A void writes no reversing row | The reversal IS `status = VOIDED` + void metadata + audit | D-11 |
| `createSale` takes a `tx` it did not open | Deliberate: the sale and its idempotency key must commit together | D-10 |
| Sale amounts are strings in JSON | `Decimal` → JSON number is the float bug §4.1 forbids | D-13 |
| `Shop` has no day-start hour, but branches open at different times | Correct. Opening hours are per-shop (`Shift`); the *reporting-day cutoff* is global at 04:00. Different things. | D-18 |

---

## Decisions taken during Phase 1

Each of these was an owner decision or resolved a genuine ambiguity. They are
binding.

### D-1 · Synthetic `.invalid` email addresses

**The `user.email` column contains fake addresses. This is correct. Do not
wire up real email.**

Better Auth requires a unique, non-null `email`. The business collects none —
staff have no work addresses (§5.4). So user creation generates
`<username>@marblehouse.invalid`.

`.invalid` is reserved by RFC 2606 and can never resolve. That is the point: if
an email-sending path is ever enabled by mistake, it fails hard rather than
delivering mail to a real stranger. Never use `.local` — that is mDNS and does
resolve on a LAN.

Rules:
- Never displayed in the UI, never editable. It is an internal key, not contact
  information. It is deliberately absent from `toUserDTO()`.
- Every email flow stays disabled: no verification, no reset emails, no magic
  links.
- A forgotten password is reset by the owner from Settings → Users.

Generated in `src/server/services/users.ts` → `syntheticEmail()`.

### D-2 · `banned` is the single source of truth for user access

There is **no `isActive` column on `User`**. Better Auth's admin plugin owns
`banned`, and that is what gates sign-in.

- The DTO exposes `isActive: !banned` for the UI only.
- UI copy says **Deactivate / Reactivate / Deactivated** — never "ban". Most
  deactivations are staff leaving, not misconduct.
- `banReason` records why; every change is audit-logged (§4.16).
- `banExpires` gives temporary suspension for free. No UI for it yet; don't
  design it out.
- **Scope: `User` only.** `isActive` on `Shop`, `Customer`, `PrizeItem` and
  `ShopPrizeConfig` is untouched — unrelated domain flags.
- Deactivating never deletes or orphans historical rows. Sales, ledger entries
  and attendance stay intact and still attribute to that user.

### D-3 · Usernames are immutable after creation

`username` seeds the synthetic email (D-1). Keeping the two in sync would be a
class of bug for no benefit. `displayName` is the mutable, human-facing field.

To change a username: deactivate the account, create a new one. `updateUserSchema`
deliberately has no `username` field.

### D-4 · The admin plugin's `adminRoles` is deliberately NOT wired up

**This one will look like a bug. It is not.**

Better Auth's admin plugin has its own access-control system with a `roles` map.
Our `OWNER`/`MANAGER`/`STAFF` are **not** registered in it, on purpose —
teaching the plugin a second, parallel notion of "privileged" would give us two
sources of truth for permissions, exactly the drift §5.4 warns about.

Authorisation lives in `src/server/auth/guards.ts` and is checked on every
request.

**Consequence:** `auth.api.createUser` and `auth.api.setUserPassword` are
plugin-gated and return **403** for us. Privileged operations therefore go
through `auth.$context` → `internalAdapter` instead, *after* our own
`requireOwner()` has authorised the call. This is intentional. Replacing it with
the `auth.api.*` calls will break user creation and password resets in
production.

Affected: `createUser()`, `resetUserPassword()` in `services/users.ts`, and the
forced-change branch of `changePassword()` in `services/auth.ts`.

### D-5 · Business date comes from the user's DEFAULT shop

`dayStartHour` is per-shop (§4.2), but `WorkSession` is uniquely keyed on
`(userId, businessDate)` — and at the moment the shop picker appears, the user
has not chosen a shop yet. Circular.

Resolved: compute the actor's business date from their **`defaultShop`**
(falling back to `TZ` + hour 6). It is stable, known before the picker is
answered, and does not shift when the user switches branches mid-day — which
would otherwise create a second `WorkSession` row for one real day.

Transactional rows in later phases still take their **own shop's** hour.

See `actorBusinessDate()` in `src/server/auth/context.ts`.

### D-6 · UI component library

shadcn/ui, installed via its CLI. The current CLI emits the **`base-nova`**
style built on **`@base-ui/react`**, not Radix. Files are committed; we own them.

Two consequences that will trip you up:
- Composition uses a **`render`** prop, not Radix's `asChild`.
  `<Button render={<Link href="/" />}>` — not `<Button asChild>`.
- The registry's **`form`** entry is an empty stub. The real component is
  **`field`**. `react-hook-form` + `@hookform/resolvers` are installed for when
  a phase needs them.

**Touch-target scale is customised** in `components/ui/button.tsx` and
`input.tsx` for NF-3 / §8.11. Do not restore shadcn's desktop defaults:

| size | height | use |
|---|---|---|
| `sm` | 44px | the floor — dense contexts, table row actions |
| `default` | 48px | ordinary buttons; inputs match |
| `lg` | 56px | primary action on a screen |
| `xl` | 64px | the one dominant action (Record sale, Confirm redemption) |
| `icon` | 44×44 | square — height alone is not a target |

### D-7 · No `next/font/google`

It downloads fonts at **build** time. This app is rebuilt in Docker on the
owner's own machine; a build that needs `fonts.googleapis.com` can fail at 9pm
for reasons unrelated to the code. `app/layout.tsx` uses a system font stack.

### D-8 · TanStack Query is installed but unused in Phase 1

Provider is wired in `app/providers.tsx`. Phase 1 screens are server-rendered
and need no client cache. Mutations are configured `retry: 0` — **a retried sale
is a duplicate sale**. Idempotency keys arrive in Phase 2 (NF-5).

---

## Decisions taken during Phase 2

### D-9 · A mismatched idempotency key is a 409, never a silent pass

**Owner decision.** `IdempotencyKey.key` is the primary key, so keys are global
rather than per-user. A replay is only honoured when **both** the `userId` and
the `endpoint` match the stored row. Anything else throws `CONFLICT`.

Why not scope the key to the user and let collisions through silently: a key
that arrives with the wrong owner is either a client bug or someone probing, and
both cases are better surfaced than absorbed. Silently recording a *second* sale
under a colliding key would defeat the point of the mechanism, and silently
returning the *stored* one would hand a user another user's sale data.

The alternative considered was `@@id([userId, key])`, which makes collisions
between users structurally impossible. Rejected because it needs a migration and
the 409 already closes the hole. If a later phase migrates it anyway, the
ownership check in `replay()` becomes redundant — leave it in regardless.

See `src/server/idempotency.ts`.

### D-10 · Idempotency and the work it protects share ONE transaction

`runIdempotent()` opens the transaction and passes the `tx` client to the
service. This is not incidental plumbing — it is the whole mechanism:

- Key written first, sale second → a crash between them burns the key and loses
  the sale. The staff member retries, gets the stored (empty) response, and the
  sale never exists.
- Sale written first, key second → a crash produces the duplicate this exists to
  prevent.

Both inside one transaction, with the primary key on `key` as the arbiter, means
**the database decides who wins a concurrent double-tap**, not application code.
The losing tap gets `P2002`, rolls back its own sale, and returns the winner's
response. Verified concurrently in `scripts/verify-phase2.sh`, not just
sequentially — a sequential replay test would pass even with a broken
implementation.

**Consequence for later phases:** any service function that must be idempotent
takes a `Prisma.TransactionClient` as a parameter rather than reaching for
`prisma` directly. `createSale` follows this shape; copy it.

### D-11 · A void is a status flip, not a second Sale row

§4.3 says "a void creates a reversing record". The schema has no shape for a
negative sale — no `reversesSaleId`, and `Sale.status` plus `voidedAt` /
`voidedById` / `voidReason` is clearly the intended design.

So the reversing record is: `status = VOIDED` + the void metadata + an audit
row. Revenue is defined as `SUM(amount) WHERE status = COMPLETED` (§9), so a
voided sale leaves the total by definition rather than by being cancelled out.

A literal negative row was rejected because every report in Phase 8 would then
have to remember to exclude it, and the one that forgets double-counts the
reversal.

### D-12 · Voiding a sale rolls `lastSeenAt` back

**Owner decision.** When a sale is voided, `Customer.lastSeenAt` is recomputed
as the `MAX(occurredAt)` of that customer's remaining **COMPLETED** sales,
falling back to `firstSeenAt` when none remain.

The alternative was to leave it alone on the grounds that the customer did
physically visit. The owner chose correctness of the visit-history metric: a
void usually means the visit was misrecorded, and §8.5 shows "last seen" on the
owner's customer tab where a stale date is misleading.

`refreshLastSeenAt()` in `services/customers.ts` runs inside the void's
transaction. **Phase 3 note:** marble and ticket ledger entries also touch a
customer; if they ever set `lastSeenAt`, this function must learn about them, or
a void will roll the date back past a genuine deposit.

### D-13 · Sale amount crosses the wire as a string

`Decimal` handed to `JSON.stringify` becomes a JS number, which is the float
hazard §4.1 exists to prevent. `toSaleDTO` calls `.toString()` on every money
field, and the client formats from the string. Never `Number(sale.amount)`
anywhere that the result is stored or summed.

### D-14 · The empty-query customer search is shop-scoped

§8.2 asks for a "recent customers at this shop" list in the sale picker.
Rather than a second endpoint, `GET /api/customers` takes an optional `shopId`
that applies **only when the query is empty** — typing a search always searches
globally, because a customer's balance is global and they may be new to this
branch (§4.5).

`shopId` is checked with `assertShopAccess` in the handler. Without that, it
would be a way to enumerate another branch's customers.

### D-15 · A preset is validated against the actor's own shop

`resolveAmount()` reads the preset's amount **from the database**, never from
the client, and rejects a preset whose `shopId` is not the work-session shop
(404). A client sending `{presetId, amount}` cannot make them disagree, and one
branch's price list cannot be used to record takings at another.

### D-16 · Idempotency key cleanup is deferred to Phase 9

§11 schedules a nightly job to delete keys older than 24 h. **That job does not
exist yet** — `node-cron` is not installed and no job runner is wired, and
building one now would be reaching into Phase 9.

The TTL is still honoured on the read path: a replay is matched on user and
endpoint, and stale rows are inert. What is missing is only the reclaim of disk
space. The table grows by one row per mutation until Phase 9 lands.

### D-17 · `Shop.dayStartHour` exists in the schema but the PRD says it should not

> **SUPERSEDED by D-18, same day.** The owner chose one global cutoff at 04:00
> and it was implemented immediately. Kept here because the reasoning explains
> why the drift existed. Do not act on this entry — read D-18.

**Found during Phase 2. Read this before touching business dates.**

PRD §4.2 and correction C-1 say the business-day boundary is **global**, held in
`AppSetting["businessDayStartHour"]`, and that `Shop.dayStartHour` was dropped —
§6's `Shop` model carries an explicit comment saying so.

**The column is still in `prisma/schema.prisma` and is what the code reads.**
`actorBusinessDate()` uses `defaultShop?.dayStartHour ?? 6`, and Phase 2's
`createSale` / `todaySummary` use `shop.dayStartHour`. It is seeded to 6
everywhere, so **every shop currently agrees and no behaviour is wrong today.**

Phase 2 did not change this, deliberately:

- CLAUDE.md says `prisma/schema.prisma` is the authority when it and the PRD
  drift, and Phase 1 is built on the column.
- Removing it is a migration plus a change to `context.ts`, which is Phase 1
  territory, and the brief for this session was explicitly "do not rework
  Phase 1".
- It is latent, not active: the bug C-1 describes only appears if someone sets
  two shops to *different* hours.

**What a future session should do:** either drop the column and move the value
to `AppSetting` as C-1 intends (the cleaner end state, and it removes a real
footgun), or correct §4.2/C-1 to say the hour is per-shop with the actor's
default shop deciding the work-session date. **Do not leave it ambiguous past
Phase 8** — daily reporting groups by `businessDate`, and two shops with
different hours would make "today's revenue" mean two different things in one
report.

Until then: a transactional row takes **its own shop's** hour (D-5's rule), and
the actor's work-session date takes the **default shop's**. That is what the
code did before D-18.

### D-18 · The business day is global and starts at 04:00

**Owner decision, 4 Aug 2026. This resolves D-17 and closes correction C-1.**

`Shop.dayStartHour` is **dropped**. The boundary now lives in
`AppSetting["businessDayStartHour"]`, seeded to **4**, read through
`getBusinessDayStartHour()` in `src/server/services/settings.ts`.

**Why global.** Daily reporting groups by `businessDate` (§4.2). If two
branches used different hours, a combined revenue report would sum two
different definitions of "a day" — wrong in a way nobody spots, because the
total still looks plausible. It also removes C-1's circularity: `WorkSession`
is keyed on `(userId, businessDate)`, but the date must be known before the
user picks a shop.

**Why 04:00 specifically.** The owner confirmed the business reality that
settles it: branches have **different opening hours** (mall sites vs
standalone), but **none trade past 23:59**. The cutoff's only job is to sit in
a dead hour so no shift is ever cut in half — it is *not* meant to track
opening times. 04:00 clears the latest close by four hours and leaves margin
before any early-morning setup. Verified at the boundary: 23:59 and 03:59 file
under the previous day; 04:00 starts the new one.

**The distinction that matters, because it is easy to confuse:**

| | What it is | Where it lives |
|---|---|---|
| Business-day cutoff | Which date a record is filed under | **Global**, `AppSetting` |
| Opening / closing hours | When a branch trades, and staff lateness | **Per shop**, `Shift` (§4.14) |

Setting a branch's cutoff to its opening hour would be the mistake this entry
exists to prevent. Do not reintroduce a per-shop cutoff.

**Supersedes D-5's second rule.** D-5 said a transactional row takes its own
shop's hour while the work session takes the default shop's. There is now one
hour, so both agree by construction — which is the point. The *timezone* still
comes from the shop (falling back to `TZ`); v1 assumes one timezone across all
branches (§11).

**Migration:** `20260804190000_global_business_day_start_hour`. It writes the
setting **before** dropping the column, carrying an existing database's
configured value forward (via `MIN()` across shops) rather than silently
resetting it to the new default. A fresh database gets 4.

**Changing this later is a policy decision, not a tuning knob.**
`businessDate` is stamped once, at creation, and never recalculated. Changing
the hour puts a seam in the data: records either side are filed by different
rules. Harmless now — there is no real sales data — which is exactly why it was
worth settling before the pilot.

### D-19 · `setWorkSession` absorbs a lost create race

Found while verifying D-18 on a clean database. For a **single-shop user**, the
`(app)` layout and the `/sale` page both call `resolveWorkSession()` on the same
request. Neither sees a session, both auto-select the user's only shop, and the
second `create` hits the unique key on `(userId, businessDate)` — a 500 on the
exact path §4.7 promises is seamless ("auto-select it and skip the prompt").

`setWorkSession` now catches `P2002` and returns the row that won, the same
pattern `runIdempotent` uses (D-10). The unique key exists to arbitrate this;
the service should not treat winning-or-losing as success-or-failure.

**This was latent in Phase 1, not introduced by Phase 2.** Two concurrent
requests from one single-shop user could always have raced. Phase 1's
verification passed because its checks hit the layout alone; adding a second
`resolveWorkSession` call in a page made it fire every time. A double-tap on the
picker could have triggered it in production.

`/sale` also reads the session from `resolveWorkSession()` rather than
`actor.workSession`: `getActor` is wrapped in React's per-request `cache`, so
the cached actor still carries `workSession: null` from before the layout
auto-selected. Trusting it would throw `NO_WORK_SESSION` on that same path.

---

## Decisions taken during Phase 3

### D-20 · Balance guards use one conditional database update

A negative change updates the customer only where the cached balance is still
large enough. PostgreSQL locks and re-checks that condition when concurrent
requests race, so two withdrawals against the last units cannot both succeed.
The ledger row is then inserted in the same idempotency transaction with the
returned `balanceAfter` snapshot. This avoids a read-check-write gap without
spreading explicit row-lock SQL across both ledger services.

### D-21 · Customer merge does not rewrite ledger snapshots

Merge moves sales, redemptions and both ledgers to the winning customer, then
recomputes the winning caches from the combined ledgers. Existing
`balanceAfter` values remain exactly as recorded on their original accounts.
They are forensic snapshots, and the ledgers are append-only; rewriting them to
make the merged timeline look continuous would silently falsify history.

### D-22 · Balance drift becomes a durable system alert immediately

The Phase 3 reconciliation corrects a cache from its ledger, writes an audit
row, and upserts a CRITICAL `SystemAlert`. The alert stays active after the
cache is repaired so the evidence cannot disappear before the owner sees it.
Phase 8 will present these rows on the dashboard; Phase 3 owns their durable
backend because detecting drift without preserving the warning is not useful.

### D-23 · Ticket-award threshold is a global owner setting

`AppSetting["ticketAwardReasonThreshold"]` is seeded to 500 (or the initial
environment value) and editable under Owner → System. Awards strictly above
the threshold require a reason; the threshold itself is not a block. Every
change is audit-logged. The API also requires the explicit
`ticketsCollected: true` confirmation, so bypassing the UI cannot bypass the
physical-ticket control.

### D-24 · The nightly job is registered through Next instrumentation

Phase 3 introduces the first `node-cron` job. Next's server instrumentation
starts it at 04:00 Asia/Jakarta with `noOverlap`; a PostgreSQL
transaction-scoped advisory lock is the cross-process guard. `node-cron` is a
server external in `next.config.ts` because its Node-only `child_process` and
`path` imports must not enter Next's browser/edge bundle.

### D-25 · Phase 3's commit gate was closed on 7 Aug 2026

The previous session could not complete gate 5 (*migrations are committed*)
because the workspace had no `.git` directory, and correctly refused to mark the
phase Done rather than reporting six of seven gates as a pass.

The repository has since been initialised — a single `Initial commit`
(`6b08499`) that contains `prisma/migrations/20260806104915_phase3_balance_alerts`,
all four Phase 3 services and `scripts/verify-phase3.sh`. `prisma migrate status`
reports all three migrations applied and the schema up to date.

**All seven gates were then re-run in full, not assumed from the previous
session's log:** typecheck clean, lint clean, `docker compose build` succeeds,
`verify-phase3.sh` passes every check, migrations committed, this log updated,
and §6's `SystemAlert` model verified field-for-field against
`prisma/schema.prisma` (it already matched — the Phase 3 migration was the only
schema change and the PRD was reconciled when it was written).

**Phase 4 is therefore unblocked.**

Worth knowing for next time: `docker compose build` failed on first attempt with
*"Cannot connect to the Docker daemon"* — Docker Desktop was installed but not
running. That is a stopped daemon, **not** the "Docker is not installed" case
CLAUDE.md gate 3 lets you declare. Launch it with `open -a Docker`, wait, and run
the gate for real.

---

## Decisions taken during Phase 4

> **Phase 4 is IN PROGRESS.** The FIFO engine and its §15 test suite are built;
> catalog, stocking config, receiving, the redemption cart, cost DTOs and the
> uncosted-batch queue are not. Do not mark this phase done.

### D-26 · Vitest, running against the real development database

§15 makes the FIFO engine the one module with a mandatory test suite, and §17's
Phase 4 opener says to write those ten tests *first*. No runner existed, so:
**Vitest 3**, `npm test` / `npm run test:watch`.

**The tests hit real PostgreSQL rather than a mocked Prisma client.** FIFO is
`ORDER BY receivedAt` plus conditional `UPDATE`s that the database arbitrates —
mocking Prisma would test the mock and prove nothing about the invariant. The
concurrency guard in particular only exists because PostgreSQL re-evaluates a
WHERE clause under contention; there is no way to assert that against a fake.

Two mechanisms keep this from accumulating junk the way `verify-phase*.sh` does:

- `withRollback()` in `__tests__/helpers.ts` runs each test inside a transaction
  and throws a private sentinel to force a rollback, returning the body's value
  so assertions still work.
- `inventory-concurrency.test.ts` deliberately does **not** use it — two racing
  transactions cannot share one, and the commit boundary is the thing under
  test — so it cleans up in `afterEach` instead.

Verified: after a full run, every FIFO fixture table is back to zero rows.
`fileParallelism` is off because the suite shares one database.

`setup.ts` refuses to run unless `DATABASE_URL` names a `_dev` or `_test`
database. The suite writes; a mistyped env var should not be able to reach
production.

### D-27 · Restore is refused twice, via a `VOID_RESTORE` marker movement

§4.9 says a redemption void returns stock to the exact batches it came from.
Nothing in the schema prevents that running twice, and a double restore invents
stock out of nothing.

`restoreConsumption()` therefore looks for an existing `VOID_RESTORE` movement
whose `refType`/`refId` point at the original movement, and throws `CONFLICT` if
one exists. No migration needed — `StockMovement` already carries the ref
columns and the `VOID_RESTORE` enum member.

**Consequence for Phase 5:** a cancelled transfer restores stock through this
same function and so inherits the same guard. Do not add a second restore path.

### D-28 · `toCostDTO()` / `toRestrictedDTO()` are the DTO builder names

§7.5 names the pair twice in adjacent paragraphs and disagrees with itself:
`toCostDTO()`/`toRestrictedDTO()` in one, `toOwnerDTO()`/`toRestrictedDTO()` in
the next. CLAUDE.md's cost-visibility section says `toCostDTO()`, and the gate is
`canSeeCost` — which a Purchasing **manager** also passes, so "owner" would
actually be the wrong word for it.

**`toCostDTO()` / `toRestrictedDTO()` wins.** The stray §7.5 line should be
corrected when the Phase 4 DTOs land. Phase 2's `toCustomerDTO` /
`toCustomerOwnerDTO` pair is a different gate (owner-only spend and visit
history, not cost) and is left alone.

### D-29 · §15's tests 8–10 are proven at the engine, not through Phase 5 routes

Tests 8, 9 and 10 cover opname variance and void restore — behaviour whose
*routes* are Phase 5 (transfers and opname) and Phase 4 (redemption void).
Building those routes now would break the one-phase-at-a-time rule.

The engine has to support all three regardless, so they are tested at the
`inventory.ts` level now: `weightedAverageCost()` for §15.8, `consumeFifo()`
with `type: "OPNAME_LOSS"` for §15.9, and `restoreConsumption()` for §15.10.
When Phase 5 builds the opname and transfer routes, it wires them to these
functions and adds route-level tests — it must not reimplement the arithmetic.

### D-31 · A positive manual stock adjustment is priced at zero, not guessed

`adjustStock` with a positive delta creates an adjustment batch at
`unitCogs = 0, needsCosting = true`, landing it in the owner's queue.

The alternative was to price it at the weighted average, which is what §4.11
specifies for a positive **opname** variance. Rejected here because the two are
different events: an opname variance is found stock reconciled against a
physical count, where the average is the best available estimate. A manual
adjustment has no such basis — inventing a cost would quietly distort prize
expense with a number nobody entered.

`weightedAverageCost()` exists in `inventory.ts` and is tested (§15.8), but it
is **only** for opname. Phase 5 wires it up.

### D-32 · Redemption tickets go through the Phase 3 ticket service

Checkout and void call `applyRedemptionTickets()` in `services/tickets.ts`
rather than writing their own `customer.updateMany`. That function is a thin
wrapper over the existing private `changeTickets`, widened to accept `REDEEM`
and `VOID_RESTORE`.

The negative-balance guard (D-20's conditional update) therefore exists in
exactly ONE place. A redemption that wrote its own update would be a second
copy of the invariant, and the next change to it would miss one — which is the
failure mode this avoids. Verified by mutation: removing the guard let two
concurrent redemptions both spend the same 100 tickets.

### D-33 · `/api/shops/[id]/prizes/...`, not `[shopId]`

Next requires ONE slug name per path segment across the whole route tree.
Phase 2 shipped `/api/shops/[id]/presets`, so the new stocking-config route had
to use `[id]` too. The handler destructures `{ id: shopId }` so the service
still reads clearly.

**This is worth knowing because neither `typecheck` nor `lint` catches it** —
the app simply fails to boot with *"You cannot use different slug names for the
same dynamic path"*. It was caught by starting the dev server. If you add a
route under an existing dynamic segment, boot the app before assuming it works.

### D-34 · The uncosted queue was refusing Purchasing managers — fixed

**A real bug, found by rendering the page rather than by any test.**

`listUncostedBatches(actor)` with no `shopId` required `role === "OWNER"`, so a
Purchasing manager got 403 on `/stock/uncosted` — exactly the screen §7.5 gives
them ("Purchasing managers see the queue for their own shops"). The SQL filter
underneath was already correct and narrowed to `assignedShopIds`; only the
guard above it was wrong.

Now gated on `canSeeCost(actor)`: owner sees every shop, a Purchasing manager
sees their own, a plain manager is still refused.

**Why the acceptance script missed it:** it only exercised the *scoped* form,
`/api/stock/uncosted?shopId=…`, which took the other branch. `verify-phase4.sh`
now checks both forms for both manager types. When an endpoint's permission
depends on whether a parameter is present, test it **both ways** — one branch
passing says nothing about the other.

### D-35 · Transfers and Opname are absent from the stock screen, not stubbed

§8.7 specifies five tabs: On hand · Receive · Transfers · Opname · Low stock.
Phase 4 ships three. Transfers and Opname are Phase 5 and are **not** rendered
as empty tabs — the same reasoning that keeps the attendance banner unstubbed
(a control that does nothing teaches staff the app is broken).

Phase 5 adds the two tabs to `stock-tabs.tsx`. The `StockTabs` array is built
from a list, so adding them is additive.

### D-36 · The owner keeps six bottom-nav tabs

Adding Stock pushed the owner to six tabs, which is one more than sits
comfortably on a phone. The alternative was dropping Reports — but the nav is
currently the **only** route to `/reports/tickets-awarded`, so removing the tab
would have stranded a working screen with no way in.

Six tabs and a working Reports beats five tabs and an orphaned page. Phase 10's
polish pass should fold Reports and Settings behind a single "More" tab rather
than deleting either.

### D-30 · The FIFO tests were verified by deliberately breaking the engine

A green test proves nothing until it has been seen to fail. Two mutations were
run against the finished engine:

| Mutation | Result |
|---|---|
| Drop `qtyRemaining: { gte: take }` from the conditional update | Parallel test drove stock to **−10 units** — caught |
| Sort batches by `createdAt` instead of `receivedAt` | §15.6 alone failed — caught |

Both were reverted immediately. The second is the mistake §4.10 warns about: it
only shows up *after* a branch transfer, so without that test it would have
shipped and quietly inverted the cost basis. If you refactor `consumeFifo`,
re-run these two mutations rather than trusting a green suite.

---

## What Phase 4 has built SO FAR

```
src/server/services/
  inventory.ts           THE FIFO engine. The only file allowed to consume or
                         restore stock. consumeFifo / restoreConsumption /
                         onHand / weightedAverageCost / backfillBatchCost.
  prizes.ts              Global catalog + per-shop stocking policy. Ticket-cost
                         changes audit-log and raise an owner alert (§4.8).
  stock.ts               Receiving with the Purchasing gate, the uncosted
                         queue, cost backfill, manual adjustment.
  redemptions.ts         The §4.9 checkout transaction, void, and history.
  tickets.ts             (Phase 3) + applyRedemptionTickets — see D-32.

src/server/dto/
  prize.ts               toPrizeRestrictedDTO / toPrizeCostDTO and the batch
                         pair. The restricted builders take NARROWED source
                         types that carry no cost column at all, so passing a
                         costed row to one is a type error (D-28, §7.5).

src/server/services/__tests__/
  setup.ts               Loads .env; refuses a non-_dev/_test database.
  helpers.ts             withRollback + fixture builders.
  inventory.test.ts      §15 tests 1–10, plus void-batch and Decimal cases.
  inventory-concurrency.test.ts
                         Real commit boundaries and racing transactions.
  redemption.test.ts     Checkout, all-or-nothing rollback, concurrency, void.
src/server/dto/__tests__/
  cost-visibility.test.ts  §7.5's forbidden-string scan over serialized DTOs.

vitest.config.ts         Node env, serial files, @ alias.
scripts/verify-phase4.sh 33 HTTP-level acceptance checks.
```

APIs: `/api/prizes`, `/api/prizes/[id]`,
`/api/shops/[id]/prizes/[prizeId]/config`, `/api/stock/batches`,
`/api/stock/batches/[id]/cost`, `/api/stock/uncosted`, `/api/stock/adjust`,
`/api/stock/on-hand`, `/api/redemptions`, `/api/redemptions/[id]/void`.

**§16 criteria now proven:**

| Criterion | How |
|---|---|
| Every §15 FIFO test passes | `npm test` — 36 tests, ten of them §15.1–15.10 |
| A plain manager provably cannot see cost | `verify-phase4.sh` greps the real serialized response of every prize/stock/redemption endpoint for `cogs`/`unitcost`/`valuation`/`margin`/`profit`, as a manager AND as staff; plus the DTO-level scan in `cost-visibility.test.ts` |
| A Purchasing manager sees cost only at their own shops | 200 at an assigned shop, 403 at an unassigned one, and still 403 on an owner report |
| Concurrent redemptions behave correctly | Two racing checkouts with tickets for one → exactly one succeeds; same for the last unit of stock; a double-tap with one Idempotency-Key creates exactly one redemption |

All four are proven on a dev machine. The device-level half of §16 and §15's
manual checklist — a real staff member, a real tablet, real shop wifi — is
**still outstanding** and is the remaining gate on calling Phase 4 done.

### Screens (added after the API layer)

```
src/app/(app)/customers/[id]/redeem/
  page.tsx               Server: resolves the session, lists shop-stocked
                         prizes, narrows to 4 fields before the client sees it.
  redeem-cart.tsx        The §8.6 cart: live balance header, greyed-but-visible
                         unaffordable prizes, one idempotency key per attempt.

src/app/(app)/stock/
  page.tsx               §8.7 shell + the uncosted warning banner.
  stock-tabs.tsx         On hand · Receive · Low stock (see D-35).
  uncosted/page.tsx      The §7.5 "batches awaiting cost" queue.
  uncosted/uncosted-queue.tsx   Pricing a batch, with the backfill explained.
```

`/customers/[id]` gains a Redeem button, and OWNER/MANAGER gain a Stock tab
(D-36). Verified by rendering every new page as all four roles: staff is 403 on
`/stock`, plain managers are 403 on `/stock/uncosted`, and the rendered HTML for
a manager and staff contains no cost string.

**Still to build for Phase 4:** nothing structural — but the phase is **not
signed off**. §16's acceptance is partly device-level, and §15's manual
checklist wants a real staff member using the redemption flow on the actual
tablet. That has not happened. Everything above is verified on a development
machine only.

Phase 5 (transfers and opname) inherits: the two missing §8.7 tabs (D-35), and
`weightedAverageCost()` in `inventory.ts`, which is built and tested (§15.8) but
has no caller yet.

---

## What Phase 3 actually built

```
src/server/services/
  marbles.ts             Deposit / withdraw / correction with atomic guards.
  tickets.ts             Award / correction + collected/threshold controls.
  balances.ts            Paginated combined history and reconciliation.
  ticket-reports.ts      Owner Tickets Awarded by Staff ratio report.

src/server/jobs/
  scheduler.ts           04:00 reconciliation schedule + overlap guard.

src/server/dto/
  ledger.ts              Explicit balance-mutation and history response shapes.
```

Routes: customer balance actions/history, Owner → Reports → Tickets Awarded by
Staff, and Owner → Settings → System. APIs: marble deposit/withdraw/adjust,
ticket award/adjust, combined ledger history, customer merge, ticket-award
report, and threshold read/update.

Migration `20260806104915_phase3_balance_alerts` adds durable `SystemAlert`
rows. `scripts/reconcile-balances.ts` is the on-demand form of the nightly job;
`scripts/verify-phase3.sh` is the re-runnable acceptance proof.

---

## What Phase 2 actually built

```
src/server/
  idempotency.ts        runIdempotent / parseIdempotencyKey (NF-5, R-3).
                        The transaction boundary lives here — see D-10.

src/server/services/
  sales.ts              listPresets / createSale / voidSale / listSales /
                        todaySummary. Role scoping is applied as a SQL filter
                        the caller's parameters cannot widen.
  customers.ts          searchCustomers / createCustomer / updateCustomer /
                        getCustomerForActor / refreshLastSeenAt.
  settings.ts           getBusinessDayStartHour — the GLOBAL 04:00 reporting
                        boundary (D-18). Every businessDate computation reads
                        it; never pass a shop's own hour.

src/server/dto/
  sale.ts               toSaleDTO — money as string (D-13).
  customer.ts           toCustomerDTO (all roles) and toCustomerOwnerDTO
                        (OWNER only). The restricted builder physically does
                        not read spend/visit columns — the §7.5 pattern that
                        Phase 4 reuses for COGS.
```

Routes: `/customers`, `/customers/[id]`, and a real `/sale` screen replacing
the Phase 1 placeholder.
APIs: `/api/sales`, `/api/sales/[id]/void`, `/api/sales/today-summary`,
`/api/customers`, `/api/customers/[id]`, `/api/shops/[id]/presets`.

### The sale screen (§8.2)

Design target is **three taps**, and the acceptance criterion is 20 sales at
under 15 s each. Things that look like small UI choices but are load-bearing:

- **Payment method persists between sales; amount and customer reset.** Most
  shops are overwhelmingly cash, so re-tapping CASH 20 times is 20 wasted taps.
- **Success is a toast, not a modal** (§8.2: "no modal to dismiss"). A modal
  adds a fourth tap to every sale.
- **One idempotency key per sale attempt**, regenerated only after a sale
  lands — held in a `useRef`. If it were regenerated per render or per tap, a
  double-tap would send two different keys and create two sales, which is the
  exact failure the key exists to prevent.
- The submit button disables during flight **and** sends the key. The disable
  alone loses the race on a slow connection.

---

## What Phase 1 actually built

```
src/server/auth/
  auth.ts         Better Auth config — argon2id, username + admin plugins,
                  additionalFields, rate limiting. The only file that
                  configures the auth library.
  password.ts     argon2id params + the 100-common-password blocklist.
  session.ts      Thin typed accessor over Better Auth's session.
                  AuthUserFields declares additionalFields explicitly —
                  §5.4 says do NOT cast to `any`, and we don't.
  context.ts      Actor: user, role, assignedShopIds, businessDate,
                  workSession. canSeeCost / canSeeCostForShop / hasShopAccess.
  guards.ts       API guards — requireActor, requireOwner, requireShopAccess…
  page-guard.ts   Page guards — call forbidden() for a real HTTP 403.

src/server/services/
  auth.ts         login / logout / changePassword / me + landingPathFor
  work-session.ts setWorkSession / changeWorkSession / resolveWorkSession
  users.ts        listUsers / createUser / updateUser / resetUserPassword

src/server/
  errors.ts       AppError + the §7 error-code table → HTTP status
  http.ts         handleRoute / parseJson — keeps handlers to 3 jobs
  audit.ts        writeAudit — accepts a tx client; append-only
```

Routes: `/login`, `/change-password`, `/select-shop`, `/dashboard`, `/sale`,
`/settings`, `/settings/shop`, `/settings/users`.
APIs: `/api/auth/{login,logout,me,change-password,[...all]}`,
`/api/work-session`, `/api/users`, `/api/users/[id]`,
`/api/users/[id]/reset-password`.

### Patterns to copy in later phases

- **Route handlers do three things.** Authenticate, validate with Zod, call a
  service. See `app/api/work-session/route.ts` — it is the reference shape.
- **Guards return the `Actor`**; pass it to the service. No service function
  queries the database without knowing the actor (§5.4).
- **Errors** are thrown as `AppError` from services and converted by
  `handleRoute`. Never build error JSON in a handler.
- **Page guards call `forbidden()`**, which needs `experimental.authInterrupts`
  (already on in `next.config.ts`). A thrown error would be a 500, not a 403.
- **Audit rows take the transaction client** so they commit with the change
  they describe.
- **Middleware checks cookie presence only** — it is a redirect convenience,
  never a permission. It also returns JSON 401 for `/api/*` rather than
  redirecting an API caller to an HTML page.

---

## Verification

```bash
npm run typecheck                 # clean
npm run lint                      # clean
npm test                          # 17 FIFO tests (D-26) — safe to re-run, no residue
docker compose build              # succeeds (catches Linux case-sensitivity)
bash scripts/verify-phase1.sh     # 21/21 acceptance checks, needs npm run dev
bash scripts/verify-phase2.sh     # 30/30 acceptance checks, needs npm run dev
bash scripts/verify-phase3.sh     # Phase 3 PASS, needs npm run dev
bash scripts/verify-phase4.sh     # 35 checks, needs npm run dev
```

All four were last re-run green on **7 Aug 2026** when Phase 3's commit gate was
closed (D-25). `docker compose build` needs the Docker Desktop daemon actually
running, not merely installed — `open -a Docker` first.

All three scripts need the dev server running and **write test data**.
`verify-phase1.sh` rewrites test users; `verify-phase2.sh` assumes those users
already exist and adds sales and a customer. Run them against a scratch
database, not one with real data, and in that order.

`verify-phase3.sh` also writes test data. It creates uniquely named customers,
runs 50 mixed balance operations, forces and repairs one cache drift, and
merges one duplicate. Run it only against a scratch/development database.

### Phase 3 §16 criteria — how each is actually proven

| Criterion | How `verify-phase3.sh` proves it |
|---|---|
| **Balances survive 50 mixed operations** | Runs 20 deposits, 10 withdrawals, 15 awards and 5 corrections, then directly compares both cached balances with ledger sums and the exact 50-row count. Also fires two concurrent withdrawals when only one can succeed; exactly one returns 200 and the other 409. |
| **Reconciliation reports zero drift** | Runs the real reconciliation command, asserts zero, deliberately corrupts one cache, asserts one correction plus a persistent CRITICAL alert and audit row, then asserts the next run returns zero again. |
| **Award above threshold needs a reason** | Server rejects 501 tickets without a reason at the default 500 threshold, accepts it with a reason, and separately rejects a request that omits `ticketsCollected: true`. Owner setting changes read back and plain managers get 403. |

Additional proof: mutation replay writes one ledger row; history is capped at
50 with an opaque continuation cursor; STAFF cannot adjust; MANAGER cannot see
the owner report or threshold; the report groups awards by staff/day; only
OWNER can merge and the merged caches reconcile to the moved ledgers.

### Phase 2 §16 criteria — how each is actually proven

| Criterion | How `verify-phase2.sh` proves it |
|---|---|
| **A double-tap creates exactly one sale** | Two requests with the same `Idempotency-Key`, fired **concurrently** with `&`/`wait` — then asserts the row count rose by exactly 1 and both responses carry the same sale id. A sequential replay is also checked, plus a 409 when a different user presents the key. A sequential-only test would pass against a broken implementation, which is why the concurrent case is the one that matters. |
| **A void reverses correctly** | Revenue is captured before, after the sale, and after the void, and must return to its exact starting value. Also asserts the row still exists as `VOIDED` (never deleted), the reason is stored, an audit row was written, STAFF gets 403, a missing reason gets 422, and a second void gets 409. |
| **20 sales in under 15 s each** | 20 sequential sales, timed. Measures the **server round trip** (~40 ms/sale here), which is the part the code controls — NF-1's budget is 2 s. The criterion as written is end-to-end on a real tablet on shop wifi and can only be closed on the device; §15's manual checklist still asks for that. |

---

## Known issues / debts

| Item | Detail |
|---|---|
| Prisma deprecation | `package.json#prisma` moves to `prisma.config.ts` in Prisma 7. Not urgent. |
| Dependency audit | `npm audit --omit=dev` reports 6 high advisories through Prisma's `effect` dependency and Next's PostCSS/sharp dependencies. The offered automatic fix upgrades outside the pinned stack (Prisma 6.19 / Next 16), so Phase 3 did not force it. Reassess as an explicit dependency/hardening update. |
| Edge Runtime build warning | From `jose` inside Better Auth. Harmless — we do not use the Edge Runtime (§5.2 forbids it) and nothing enables it. |
| Automated tests cover the FIFO engine only | Vitest landed in Phase 4 (D-26) and `npm test` covers §15's ten FIFO cases plus concurrency. Everything else is still verified only by the curl-based `scripts/verify-phase{1,2,3}.sh`. §15's other unit tests — business-date boundaries, lateness, phone normalisation — have no home yet; add them as their phases come up rather than in one late sweep. |
| Red attendance banner | Deliberately NOT stubbed. Phase 6. A fake banner that does nothing trains staff to ignore the real one. |
| Dashboard screen | Route + permission boundary only. Metrics are Phase 8. |
| ~~`Shop.dayStartHour` still exists~~ | **Resolved same day — see D-18.** Dropped; the cutoff is global at 04:00. |
| No UI for the business-day hour | §8.10 puts it under Owner → System. It is set by seed/migration only. Build the screen in Phase 9 with the other owner settings; changing it needs a warning that it does not restamp history (D-18). |
| Idempotency keys are never deleted | D-16. The cleanup job is Phase 9. Rows accumulate one per mutation until then; harmless but unbounded. |
| Void reason uses `window.prompt` | Functional and accessible, but ugly on a tablet and it cannot enforce the 3-character minimum client-side (the server does). Replace with a proper dialog in Phase 10's polish pass. |
| Customer detail has no action buttons | §8.5 specifies Deposit / Withdraw / Award / Redeem. Those are Phases 3–4 and are deliberately not stubbed. |
| Customer edit UI not built | `PATCH /api/customers/:id` exists and works; there is no edit UI yet. Owner-only merge shipped in Phase 3. |
| ~~Phase 3 migration not committed~~ | **Resolved 7 Aug 2026 — see D-25.** The repository was initialised and the migration committed; all seven gates now pass. |
| ~~`tsconfig.tsbuildinfo` is tracked~~ | **Fixed 7 Aug 2026.** It is a TypeScript incremental-build artifact that showed as modified after every `npm run typecheck`. Added to `.gitignore` and `git rm --cached`-ed, so Phase 4's diff stays readable. |

---

## Current database state

Left over from the Phase 1 verification run — **test accounts, not real ones**:

| Username | Password | Role |
|---|---|---|
| `owner` | `OwnerRealPass2026!` | OWNER |
| `manager1` | `MgrRealPass2026!` | MANAGER |
| `staff1` | `StaffRealPass2026!` | STAFF |

Shops: `BR-1` (Branch 1), `BR-2` (Branch 2), `HQ` (pseudo-shop, expense-only).

**Added by the Phase 2 verification run** — also test data, not real:

- ~45 sales at `BR-1`, all on the current business date, a few `VOIDED`.
- One customer, `Budi Test`, with a generated `0812…` phone.
- One sale preset on `BR-2` (Rp 50.000), created so the cross-shop preset
  rejection check had something real to attack with.
- Idempotency-key rows, one per mutation, which nothing deletes yet (D-16).

**Added by the Phase 3 verification run:**

- Active `Phase Three Main` customer with 36 marbles and 560 tickets, plus its
  55 combined ledger rows.
- Active `Phase Three Race` customer with 2 marbles; proves concurrent
  over-withdrawal allows exactly one request.
- One deactivated `Phase Three Duplicate` merged into the main customer.
- One active CRITICAL `BALANCE_DRIFT:<customerId>` system alert and matching
  `BALANCE_RECONCILED` audit row from the deliberate drift test.
- Ticket-award threshold restored to 500 after its owner-setting test.

**The 7 Aug 2026 re-run (D-25) added a second, independent set of these rows** —
the script names customers with a timestamped phone number, so re-running it
never collides with the previous run's data but does accumulate another
`Phase Three Main` / `Race` / `Duplicate` trio and another ~55 ledger rows. All
of it is test data on `marblehouse_dev`. `npm run db:reset` clears the lot.

**Added by the Phase 4 verification run:**

| Username | Password | Role |
|---|---|---|
| `purchaser1` | `PurchPass2026!` | MANAGER **with Purchasing** (`canEnterCost`), assigned to BR-1 only |

That account is the one §7.5 exists for, and `verify-phase4.sh` needs it to
prove the "cost at my shops, 403 at yours" criterion. The script creates it on
first run and reuses it afterwards.

Also added: a `Phase Four Bear <ts>` catalog item with four batches at BR-1
(one deliberately received unpriced, then backfilled), a `Phase Four Player`
customer, and their redemption plus its void. The `npm test` suite adds
nothing — it rolls back or cleans up after itself.

`npm run db:reset` wipes all of this and reseeds from `.env` — the owner's
password returns to `SEED_OWNER_PASSWORD` with a forced change on first login.
After a reset, run `verify-phase1.sh` before `verify-phase2.sh`, since the
latter expects the `owner` / `manager1` / `staff1` accounts the former creates.
