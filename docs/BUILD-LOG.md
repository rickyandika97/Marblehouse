# Build log — decisions made during construction

**Read this after `CLAUDE.md` and before `docs/PRD.md`.**

The PRD is the specification. This file records what was actually built and
every decision taken that the PRD does not contain or now contradicts. Where
this file and the PRD disagree, **this file wins** — it was written later, with
the code in front of it.

**Update this file before calling any phase finished** — item 7 of *Before
finishing any phase* in `CLAUDE.md` lists exactly what to write. Append; do not
rewrite history. A superseded decision gets a new entry saying what changed and
why, not an edit to the old one.

---

> **D-122 (19 Aug 2026) is a retroactive, cross-phase schema and permission
> change** — role moved from a single column on `User` to a per-shop column
> on `UserShop` (a user can be MANAGER at one shop and STAFF at another; only
> OWNER stays global). It is not tied to any phase below. **Read it before
> touching role, `canEnterCost`, `Actor`, or any guard/permission logic in
> any phase** — several things that look like the original phase's code will
> in fact be D-122's rewrite of it.

## Phase status

| Phase | Scope | Status |
|---|---|:--:|
| 0 | Scaffold, schema, seed, health endpoint | ✅ Done |
| 1 | Auth, roles, work session, app shell | ✅ Done — all §16 criteria verified |
| 2 | Sales + customers | ✅ Done — all §16 criteria verified |
| 3 | Marble & ticket ledgers | ✅ Done — all §16 criteria verified |
| 4 | Prizes, FIFO inventory, redemption | 🟨 Built + verified on dev — awaiting the on-device acceptance pass |
| 5 | Transfers and opname | ✅ Done — all §16 criteria verified on dev |
| 6 | Attendance | ✅ Done on dev — awaiting the on-device acceptance pass |
| 7 | Expenses | ✅ Done on dev — all §16 criteria verified |
| 8 | Dashboards and reports | ✅ Done on dev — §16 criterion verified; see D-66 for the deferred report screens |
| 9 | Backup, restore, hardening | 🟨 Built + verified on dev — awaiting the owner's own restore rehearsal on a second machine |
| 10 | Polish and pilot | 🟨 Code complete on dev — awaiting the on-device responsive pass and the one-branch pilot |

---

## PRD reconciliation

The PRD was edited mid-build and §6 briefly contradicted §5.4. **This was fixed
at the end of Phase 1** — §6's `User`, `Session`, `Account` and `Verification`
models were rewritten to match what was built, and verified field-for-field
against `prisma/schema.prisma`.

**`prisma/schema.prisma` remains the authority.** If the two ever drift again,
the code wins, and §6 should be corrected rather than the code.

### There is exactly one PRD: `docs/PRD.md`

**A stale duplicate, `PRD-pinball-arcade-management.md`, was deleted from the
repo root on 7 Aug 2026.** It was the original 3 Aug draft, carried in by the
initial commit and never updated — 428 lines diverged from `docs/PRD.md`, and
every one of its 55 unique lines was a **superseded** decision:

| The stale copy still said | Superseded by |
|---|---|
| `dayStartHour` is per-shop, default 06:00 | D-18 — global, `AppSetting`, 04:00 |
| `User.passwordHash`, `failedLoginCount`, `lockedUntil`, hand-rolled `Session` | §5.4 / D-1–D-4 — Better Auth owns these |
| `User.isActive` + `@@index([role, isActive])` | D-2 — `banned` is the only access flag |
| shadcn/ui with no primitive layer named | §5.7 — Base UI, never Radix |
| Phase 0 accepts on `docker compose up` at port 3000 | Dev is native on macOS at 5050 |
| New-shop flow collects a day-start hour | D-18 — there is no per-shop hour to collect |

**Why this was worth deleting rather than leaving alone.** §17's paste-at-
session-start prompt — in *both* files — instructed a cold session to read
`PRD-pinball-arcade-management.md` in full, while `CLAUDE.md` points at
`docs/PRD.md`. A session that followed §17 literally would have read the stale
copy and taken six reversed decisions as current, including two (`passwordHash`
on `User`, per-shop `dayStartHour`) that CLAUDE.md explicitly warns against
"fixing". Reconciling the duplicate was never an option worth taking: two copies
of a spec drift again the moment one is edited.

§17 now names the real reading order — `CLAUDE.md` → `docs/BUILD-LOG.md` →
`docs/PRD.md` — states the precedence rule, and carries a short tombstone so a
future reader who finds the old filename in git history knows it was deleted on
purpose. The deleted content remains recoverable at commit `6b08499` if it is
ever genuinely needed.

**If a copy of that file reappears, delete it. Do not merge it.**

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

> **There were seven gates at the time.** CLAUDE.md now lists **eight** — a
> `npm test` gate was added on 7 Aug 2026 (D-37), after Phase 3 closed. Phase 3
> passed every gate that existed when it shipped; it has no automated tests of
> its own, which is recorded under *Known issues / debts*.

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

The same technique found two more later in the phase: removing the ticket
balance guard let two concurrent redemptions spend the same tickets twice
(D-32), and the uncosted-queue permission bug (D-34) was found by rendering the
page as each role. **Mutation and role-by-role rendering both earned their keep
this phase. Neither is optional when you touch this code.**

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

### D-37 · `npm test` is now a phase gate — CLAUDE.md lists eight, not seven

**Owner decision, 7 Aug 2026.**

CLAUDE.md already made tests mandatory for the FIFO engine, but the seven-gate
checklist never mentioned them. A session could therefore pass every gate
without running `npm test` once. Now gate 3, placed with the other automated
checks and ahead of the slow Docker build so it fails fast.

The gate is deliberately **not** just "the suite is green" — it also requires
that the phase's new logic is actually covered, and that anything enforcing an
invariant has been **seen to fail**. Phase 4 is the evidence for that wording:
three real defects were found by breaking guards on purpose (D-30, D-32), and a
fourth by rendering pages role-by-role (D-34), none of which a green suite would
have surfaced on its own.

Gate 5 gained a matching requirement: if the phase ships a screen, boot the app
and load every new page as each role. `typecheck` and `lint` both pass on a
route tree Next refuses to start (D-33).

Old gates 4–7 shifted to 5–8. The build-log gate is now **item 7**.

**Phases 1–3 predate this** and have no unit tests of their own — they are
covered by the curl-based `verify-phase{1,2,3}.sh` only. That debt is recorded
below; the gate applies from Phase 4 onward rather than retroactively blocking
work on already-closed phases.

---

## Decisions taken during Phase 5

### D-38 · Cancelling a transfer requires a reason

**Owner decision, 7 Aug 2026.**

§4.10 says a transfer can be `CANCELLED` while `IN_TRANSIT` and the batches are
restored at the source. It does not say whether a reason is needed. Three
options were put to the owner; they chose **restore, with a mandatory
audit-logged reason**, matching how a sale void already works (§4.3).

The reasoning: a cancel *after the box has physically left* is the case worth a
paper trail, and it is indistinguishable in the data from a dispatch that was
simply mis-keyed. The reason is what separates them later.

**What cancel does NOT do:** it does not try to model a lost box. If the stock
genuinely never comes back, the owner writes it off separately through opname
or a damage adjustment, so a real loss appears as shrinkage rather than
disappearing inside a cancelled transfer. Cancel restores; loss is a different
event. Do not merge them.

Rejected: blocking cancel once dispatched. It is the most physically faithful,
but the common case is a mis-keyed dispatch, and blocking it would strand
stock in transit with no way back.

### D-39 · `allowDirectTransfer` was built now, not deferred

**Owner decision, 7 Aug 2026.**

§4.10's shop setting collapses dispatch and receive into one step. The column
already existed, and the flag turned out to be a single branch at the end of
`dispatchTransfer`.

Crucially, direct mode **calls the same `applyReceive` helper** the two-step
flow calls rather than duplicating the batch-recreation logic. That is what
guarantees both paths preserve `receivedAt` identically — a second copy would
be a second place to get FIFO wrong, and only one of them would have a test.

Default stays **off**. Both paths are tested (`lands the stock at the
destination in one step` / `stays two-step when the shop does not allow it`).

### D-40 · Preserving `receivedAt` is the load-bearing rule of the whole phase

§4.10 says a received batch keeps the original `unitCogs` **and** the original
`receivedAt`. The second half is easy to skip, because stamping arrival time
*looks* more natural and everything still appears to work.

It does not work. FIFO sorts on `receivedAt`, so a transferred batch that took
today's date sorts as the newest stock at the destination, and the destination
consumes its *expensive local* batch first. **Verified by mutation: the cost of
one consumption went from 2500 to 45000 — an 18× overstatement**, and the total
still looked plausible.

This is D-30's second engine mutation reappearing one layer up. The test
`preserves receivedAt so a transferred batch keeps FIFO priority` exists
specifically to hold it, and `verify-phase5.sh` re-checks it against the
database. **If you refactor `applyReceive`, re-run that mutation.**

### D-41 · Opname reveals the system count only after the count is entered

§4.11's anti-anchoring rule is implemented as a *server* guarantee, not a UI
convention: `POST /api/opname` returns the item list with **no quantities at
all**, and `systemQty` is read server-side when the counted lines are saved.

The screen therefore cannot leak what it never received. Had the quantity been
sent early and merely hidden in the client, anyone with dev tools — and every
future refactor of that component — would defeat the control.

Why it matters commercially: a counter who can see "40" will find 40. The count
stops being independent evidence, and opname becomes a formality that
rubber-stamps whatever the system already believed.

Tested at both levels: a service test asserts the DTO's keys, and
`verify-phase5.sh` asserts it against the real HTTP body.

### D-42 · `weightedAverageCost()` finally has a caller — and only one

Built and tested in Phase 4 (§15.8) with nothing wired to it (D-29). Phase 5
wires it to exactly one place: pricing a **positive opname variance**.

Do not reach for it anywhere else. In particular it is **not** how a manual
stock adjustment is priced — D-31 prices that at zero deliberately, because a
manual adjustment has no basis for an estimate and inventing one would distort
prize expense with a number nobody entered. An opname variance is different:
it is found stock reconciled against a physical count, where the average is the
best available basis.

**It returns 0 when nothing is on hand**, which is correct (found stock of a
brand-new prize is free rather than undefined) — but it means a test that
drains a shop to zero first will assert nothing. That happened while writing
`verify-phase5.sh`; the script now restocks before testing positive variance
and asserts the exact average.

### D-43 · A verification script must fail when its own query fails

`verify-phase5.sh` reported a false **PASS** on its first run. One `db` query
was malformed, node exited with a syntax error, the check compared two empty
strings, and `chk` called it a pass.

Two fixes, both worth copying into the other verify scripts if they are ever
touched:

1. **`chk` now fails an empty actual value** when a non-empty one was expected.
   A check that passes because it crashed is worse than no check.
2. **`db` queries are hoisted into their own assignments** rather than nested
   inside a `chk` argument. `"$(db "…{where:{…}}…")"` inside another quoted
   argument was being mangled by brace expansion before node ever saw it.

The wider lesson is the one CLAUDE.md already makes about tests: a green check
proves nothing until you have seen it go red. This one had never been seen red.

---

## Decisions taken during Phase 6

### D-44 · A photo with NO EXIF date is accepted

**Owner decision, 7 Aug 2026.**

§4.13 says to block gallery uploads by rejecting a photo whose EXIF
`DateTimeOriginal` is more than 10 minutes old. It does not say what to do when
there is no EXIF date at all — and that is the **normal** case, because the
`getUserMedia` → canvas → blob path §4.13 itself mandates produces a JPEG with
no EXIF whatsoever.

The rule is therefore: **reject only when a date is present AND stale.**

| Photo | Result |
|---|---|
| No EXIF date | **Accept** — normal live capture |
| EXIF ≤ 10 min old | Accept |
| EXIF > 10 min old | **Reject** — a gallery pick |

Rejecting the no-EXIF case was considered and refused: it would block nearly
every genuine clock-in while stopping no realistic cheat, since anyone
deliberately uploading an old file can strip EXIF as easily as we can read it.
Flagging it instead was also refused — it would flag almost every record, which
trains the owner to ignore the flag.

**What actually carries the weight is not the EXIF check.** The client has no
file input at all, the server stamps its OWN clock into the watermark, and
`clockInAt` is never client-supplied. The EXIF rule is one cheap extra layer,
not the control.

`exifDateIsStale()` in `services/attendance-photo.ts`.

### D-45 · The banner does not block work

**Owner decision, 7 Aug 2026.**

§4.13's flow is explicit: banner appears → *"user can work normally"* → user
taps banner → clock-in → banner disappears. So a staff member who has not
clocked in can still record sales, redeem prizes and everything else.

The alternative — blocking sales until clock-in — was refused. A customer
waiting at the counter while staff fight a camera permission dialog is a real
cost, and the attendance record captures the true arrival time whenever it is
made, so lateness reporting is unaffected either way.

**The banner is still not dismissible.** There is deliberately no close button
and no `dismissed` state in `components/attendance-banner.tsx`: it clears for
exactly one reason, which is that the user clocked in. A banner staff can
dismiss is a banner staff will dismiss, and the record it exists to produce
never gets made.

### D-46 · Lateness takes the day offset as a fact, not a guess

The first version of `computeLateness` inferred a midnight crossing from a
heuristic — "a delta over 12 hours must really be an early arrival". A mutation
proved that branch was **unreachable**: a raw 00:05 against a 22:00 start is
already −1315, so deleting the whole correction left every test green.

It was also *wrong*. It read a genuinely late 00:05 arrival as 22 hours early,
and therefore on time.

The caller now passes `clockInDayOffset` (0 or 1) as a fact, derived by
`clockInDayOffsetFor()` from the shift window. Both branches are reachable and
both are tested; a 00:05 clock-in for a 22:00 shift is correctly 125 minutes
late.

**The grace boundary is inclusive** (§15): the comparison is `> graceMin`,
never `>=`. 5:00 late is on time; 5:01 is late. `lateMinutes` measures from
shift **start**, not from the end of grace — grace decides *whether* someone is
late, and the stored number is how late they actually were.

### D-47 · `sharp` and the edge instrumentation bundle

**Three bundling problems, one root cause. Read this before touching
`next.config.ts` or anything that imports `attendance-photo.ts`.**

`instrumentation.ts` is compiled for **both** the node and edge runtimes, even
though its body returns early unless `NEXT_RUNTIME === "nodejs"`. Webpack still
walks the entire import graph, so `instrumentation → scheduler →
photo-retention → attendance-photo` dragged filesystem code into a bundle that
cannot resolve Node built-ins.

| Symptom | Fix |
|---|---|
| `Module not found` inside sharp's own internals | `sharp` added to `serverExternalPackages` and `externals`, exactly like `node-cron` (D-24) — it loads platform-specific native binaries |
| `UnhandledSchemeError: node:crypto` | Replaced `randomUUID` from `node:crypto` with the global `crypto.randomUUID()` |
| `UnhandledSchemeError: node:fs/promises` | **Not** replaceable. `attendance-photo` is excluded from the edge bundle by an `externals` matcher |

A `resolve.alias` keyed on the `@/` path did **not** intercept the request; the
`externals` function does. Making the scheduler's import dynamic did not help
either — webpack follows dynamic imports too.

Nothing in the edge runtime can legitimately reach the photo module: it reads
and writes files, which the edge runtime cannot do at all. `docker compose
build` passes, so the exclusion holds for the Linux production build too.

### D-48 · sharp must be materialised before it is measured

**This cost two separate bugs in one phase, in unrelated files. It will cost a
third if you do not know it.**

Calling `.metadata()` or `.stats()` on a sharp pipeline that has a *pending*
operation reports the **source** image, not the result:

- In `attendance-photo.ts`, `metadata()` after a pending `.resize()` returned
  the original dimensions, so the SVG overlay was built too large and
  `composite` threw *"Image to composite must have same dimensions or
  smaller"* — for every photo wider than 1080px, which is every real phone
  photo. The 640px test fixtures never reached it.
- In `scripts/lib/check-watermark.mjs`, `.stats()` after a pending
  `.extract()` returned whole-image stats, so every region measured
  identically and the watermark check could never fail.

**Always `.toBuffer()` first, then measure the buffer.** Both sites now do.

### D-49 · Retention deletes the photo, never the record

§4.15 keeps attendance photos 61 days. `services/photo-retention.ts` deletes
the file, nulls `photoPath` and sets `photoPurgedAt` — and there is
deliberately **no `attendance.delete` anywhere in that file**.

Losing the image is the policy; losing the lateness history with it would
destroy the only reason the record exists, and would conveniently erase the
evidence for whatever wage dispute made someone want it gone.

Ordering is deliberate: the **file** is removed first, then the row is updated.
A crash between them leaves a row pointing at a missing file, which the photo
route already answers with a 404. The opposite order would leave an orphan file
that nothing knows about and nothing will ever clean up.

Registered at 03:00 in `jobs/scheduler.ts` (§11), alongside Phase 3's 04:00
reconciliation.

### D-50 · `handleRoute` passes a `Response` through untouched

The attendance photo route returns image bytes, not JSON. Rather than opting
out of `handleRoute` and hand-rolling a try/catch — which would have given one
route a different error envelope and a different guard — `handleRoute` now
returns a handler's `Response` unchanged.

Every route still gets the same `AppError` conversion and the same 500
behaviour. Use this for any future non-JSON endpoint (CSV exports in Phase 8
are the obvious next one) instead of writing a bespoke handler.

### D-51 · The browser pass on 7 Aug 2026 is NOT the on-device pass

**Read this before concluding Phase 6 is signed off.**

A UI review was driven through Chrome against `localhost:5050` on the
development Mac at the end of Phase 6. It verified a great deal — see the table
below — but it is **not** the gate §16 and §15 are asking for, and it must not
be recorded as one.

Three specific reasons the two are not interchangeable:

| What the real gate needs | What the browser pass actually did |
|---|---|
| A real tablet, on shop wifi | A desktop Chrome window resized to 900×1200 |
| A real camera producing a real JPEG | **OBS Virtual Camera** — the only video input on this machine |
| A real geolocation prompt, granted and denied | **`navigator.geolocation` was stubbed** in page context for both paths |

The geolocation stub is the important one. It makes the *client's handling* of a
granted or denied position real, and that is genuinely worth something — but the
browser permission dialog, the thing staff will actually fumble on a tablet, was
never shown. Likewise the EXIF rule (D-44) was never exercised against a real
camera file, because a canvas-derived blob carries no EXIF by construction.

**What the browser pass DID prove**, all on dev:

| Check | Result |
|---|---|
| Banner is red, full-width, sticky, exact §4.13 copy | ✅ `bg-red-600`, 44px, sticky below the top bar |
| Banner has no dismiss path (D-45) | ✅ zero close/dismiss controls in the DOM |
| Banner does not block work (D-45) | ✅ the sale form is fully interactive underneath |
| Banner clears only on clock-in | ✅ gone after clock-in, confirmed on a different route |
| Shift chooser shows "X min late" in red (§8.9) | ✅ and the arithmetic is right — 06:00→308, 09:00→128, 10:00→68 at 11:08 |
| Live capture only, no gallery path | ✅ 1280×720 stream, canvas→blob, no file input exists |
| Location granted | ✅ lat/long/accuracy stored as `Decimal`, `locationDenied: false` |
| Location denied | ✅ clock-in proceeds, `LOCATION UNAVAILABLE` watermark, coords **null** (not zeros), flagged |
| Watermark legible | ✅ all seven §4.13 fields, verified in the **stored JPEG**, not just on screen |
| Lateness snapshot (§4.14) | ✅ `shiftStartAtCapture` + `graceMinAtCapture` both written |
| One record per day | ✅ friendly "Already clocked in", not an error |
| History + Team tabs | ✅ a manager sees own-shop staff, lateness and the denied-flag icon |
| Plain manager 403 on `/stock/uncosted` | ✅ D-34's fix still holds |

Worth knowing: the denied path stores `latitude`/`longitude`/`accuracyM` as
**null**, not zero. Zeros would have been a silent falsification — (0, 0) is a
real place in the Gulf of Guinea, and it would plot on the owner's map.

**Phase 6 therefore stays 🟨.** It needs the same tablet session Phase 4 has
been waiting for since 7 Aug; doing both in one sitting is the sensible move.

### D-52 · The "No shift applies" escape hatch had to clear the 44px floor

**A real §8.11 violation, found by measuring the rendered page rather than by
reading the diff.**

The clock-in shift chooser ends with *"No shift applies — clock in anyway"*.
It shipped as a bare text link and measured **20px tall** against NF-3's 44px
minimum.

The eleven shift cards above it were all fine at 64px, which is why this
survived review — the screen *looks* generously sized. What makes this one
count is the second half of §8.11's rule: a control below 44px is acceptable
**only when a larger equivalent exists elsewhere**. For a staff member working
an unscheduled shift, this link is the only route through the screen. There is
no larger equivalent, so the exemption does not apply.

Now `min-h-11 w-full` with a hover state — measured at **868×44** in the
browser, and clicked to confirm it still advances to the camera step with no
shift selected. Deliberately kept muted, underlined and border-free so it stays
visually secondary to the real shift options; the fix is about the tap target,
not about promoting it.

**No test.** CLAUDE.md gate 3 exempts UI polish, and a jsdom assertion on a
Tailwind class would prove nothing about rendered geometry — the measurement
that found this bug is the one that verifies the fix, and it needs a real
browser. Typecheck, lint, all 116 tests and `docker compose build` were re-run
green after the change.

### D-53 · `nativeButton` is DERIVED in the Button wrapper, not passed per call

**Owner decision, 7 Aug 2026 — fixed during Phase 6 rather than deferred.**

Base UI logged an error on every `<Button render={<a>}>` / `render={<Link>}`:
*"a component that acts as a button expected a native `<button>` because the
`nativeButton` prop is true."* Eight sites across `forbidden.tsx`, customers,
stock, reports and the clock-in flow — **not a Phase 6 defect**; it fires from
`forbidden.tsx` (Phase 1) too, verified independently.

The obvious fix is `nativeButton={false}` at each of the eight call sites. That
was rejected. **Eight sites across five phases had it wrong, which is the
failure mode of a prop you have to remember** — the ninth call site would have
been wrong too. `components/ui/button.tsx` now derives it:

```ts
nativeButton ?? (render === undefined || (isValidElement(render) && render.type === "button"))
```

No `render` → a real `<button>` → true. `render={<Link/>}` or `render={<a/>}` →
false. An explicit `nativeButton` still wins, for a case we cannot infer.
`render` may also be a *function*, where `isValidElement` correctly yields false.

**This does more than silence a warning.** With `nativeButton={false}` Base UI
adds `role="button"` and handles Space-key activation itself, so the anchors
gain the button behaviour they were missing while keeping `href` and
`tabIndex: 0`. Before the fix they activated on Enter but not Space.

Verified in a browser, not from the diff: an in-page `console.error` collector
survived three client-side navigations across `/stock`, `/customers` and a
customer detail page and captured **zero** Base UI errors, with both link
buttons on that page reporting `role="button"` and `tabIndex: 0`. The
`forbidden.tsx` site — the one proven to warn *before* the change — renders
clean.

**Do not "simplify" this back to a plain spread of `props`.** The wrapper must
keep destructuring `render` so it can inspect it.

---

## Decisions taken during Phase 7

### D-54 · `expenseShops()` is a SECOND function, not a flag on `selectableShops`

`selectableShops()` filters `isHqPseudoShop: false` — correct for its callers,
which are the day-start picker and the sale screen. HQ accepts no sales, so a
shop in that picker is a shop someone could start recording takings at.

The expense form needs the opposite: HQ is the entire reason an owner can book
a cost that belongs to no branch (§4.12). The obvious move — an
`includeHq?: boolean` option — was rejected. It puts **one `if` between HQ and
the sale flow**, and a later refactor that flips a default, or a caller that
passes the option by copy-paste, reintroduces exactly the bug the original
filter exists to prevent. A separate function cannot leak into the picker
however it is called.

`expenseShops()` sorts HQ **last** (`isHqPseudoShop: "asc"`) so the branches a
manager actually works at come first.

Verified in the browser both ways: the owner's expense form lists
`Branch 1 · Branch 2 · HQ / Unallocated`, and `/settings/shop` still lists only
the two branches.

### D-55 · Expense amount is re-validated in the SERVICE, not only in Zod

**A real bug, found by a test that called the service directly.**

`createExpense` takes an already-parsed input type, so the Zod refinement that
rejects a non-positive amount only runs when the call arrives through the route.
The first version of `expenses.test.ts` called the service directly with `"0"`
and **got a zero-value expense row**.

`toPositiveAmount()` now parses and checks at the point of the write. This looks
redundant next to the schema and is not: every other money path in this codebase
re-checks its own invariant where the write happens (D-20's conditional balance
update, D-32's single ticket guard), precisely because a schema is one caller
away from being bypassed — a job, a script, a future service, a test. A zero or
negative expense would quietly distort every §9 total that sums it.

**The general rule this is an instance of:** a Zod schema validates *a request*.
A service invariant protects *the data*. They are not substitutes, and where the
value is money the service must hold the line itself.

### D-56 · A used category's count includes SOFT-DELETED expenses

`deleteCategory` counts `expense.count({ where: { categoryId } })` with **no
`isDeleted` filter**, so a category whose only expense has been soft-deleted
still refuses to delete.

This is deliberate and the test `still refuses when the only expense is
soft-deleted` pins it. "Unused" has to mean *structurally unreferenced*, not
merely *invisible*: a soft-deleted row still holds the foreign key, and hard
deleting the category out from under it would either fail at the database or
orphan the reference. §6.1.5 keeps money rows forever, so the categories they
point at have to survive too.

The consequence to know: a category used once and then voided can never be hard
deleted. Archiving is the answer, which is what the refusal already tells the
owner.

### D-57 · Receipts are stored but NOT watermarked

§17's Phase 7 opener says receipt photos reuse `attendance-photo.ts`'s storage
shape but not its watermarking, and `services/receipts.ts` follows that exactly.

The distinction is worth stating because the two look interchangeable:

| | Evidence of | So the proof is |
|---|---|---|
| Attendance photo | *a person being somewhere at a time* | Our server's clock and place, burned in — the whole control depends on it being unforgeable |
| Receipt | *a purchase* | The printed document itself: its own vendor, date and total |

Stamping our clock across a receipt would obscure the details that make it
evidence, and would assert something untrue — we know when the image was
uploaded, not when the money was spent.

**It is still re-encoded through sharp**, which strips EXIF. On a phone photo
that EXIF carries GPS coordinates, and a receipt has no business recording
where someone was standing (§14 R-14).

Stored at 1600px, wider than an attendance photo's 1080px, because a receipt is
a document — the line items have to stay readable when the owner zooms in
months later to settle a query.

### D-58 · Expenses are reached from Settings, not a seventh nav tab

OWNER and MANAGER already carry six bottom-nav tabs, which D-36 records as one
more than sits comfortably on a phone. A seventh would make the row unusable,
and §8.0 specifies five.

So `/expenses` and `/settings/expense-categories` are linked from the Settings
list instead. Both pages enforce their own role server-side
(`requireRolePage("OWNER", "MANAGER")` and `("OWNER")`), so this is purely
about reachability — verified by loading `/expenses` as STAFF and getting a
real 403 page.

**Phase 10 should fold this properly.** D-36 already asks for a "More" tab; when
that lands, Expenses belongs in it rather than buried under Settings, which is
not where anyone would look for a daily task.

### D-59 · `verify-phase7.sh` was proven by three mutations

D-43's rule — a green check proves nothing until it has been seen red — applied
to the acceptance criterion itself. All 44 checks passed on the first run, which
is exactly when to be suspicious. Three deliberate breaks:

| Mutation | Caught by |
|---|---|
| Silently archive instead of throwing `CATEGORY_IN_USE` (the failure §17 names by name) | `deleting a USED category returns 409` → got 200 |
| Drop `usageCount` from the error details | `the usage COUNT is in the body` → **caught only by D-43's empty-value guard**; a naive `chk` would have compared `""` to `""` and passed |
| Copy Phase 5's `isHqPseudoShop` refusal into the expense guard | `an expense against HQ is accepted` |

All three reverted, `git diff` confirmed clean, and the suite re-run green. The
second is the one worth remembering: it is the exact false-pass shape D-43 was
written about, reproduced a phase later.

---

## Decisions taken during Phase 8

### D-60 · An unscoped MANAGER report means THEIR shop, not all shops

**Owner decision, 8 Aug 2026. This resolves a real contradiction in the spec.**

§7.8 grants `/api/reports/sales` and `/api/reports/attendance` to **O/M**. But
§3.4 says a manager views reports "one shop at a time", and CLAUDE.md's cost
section says a manager still gets `403` on **all-shops** endpoints. So a manager
calling a report endpoint with **no `shopId`** was undefined: it could mean "all
shops" (forbidden) or "my shop" (fine).

Three options were put to the owner. They chose **implicit scoping**:
`resolveScope()` collapses an unscoped MANAGER/STAFF request to their
work-session shop, falling back to `defaultShopId`, and throws
`NO_WORK_SESSION` if neither exists. It never returns a cross-shop aggregate
for a manager. An OWNER with no `shopId` still gets every shop.

**Why not 403 on the unscoped form**, which is the strictest reading: it would
refuse a manager loading their own dashboard, and that is *exactly* the D-34 bug
class — a permission that depends on whether a parameter is present, correct on
one branch and wrong on the other. D-34 cost a real 403 in Phase 4 for the same
reason.

**Both branches are tested, twice.** `reports.test.ts` asserts the unscoped form
resolves to one shop and the explicit form is honoured;
`verify-phase8.sh` re-checks both over HTTP plus a foreign `shopId` (403). A
mutation that let a manager fall through to the owner branch was caught by
seven checks.

### D-61 · The demo seed is REPRODUCIBLE, and that is the point

§16 accepts Phase 8 when "every metric matches a hand-calculation against the
demo dataset". §10's `--demo` flag did not exist, so it was built first.

Every random choice comes from `mulberry32` seeded with a **fixed constant**
(`prisma/demo.ts`). Verified: two full runs, separated by a `--reset-demo`,
produced identical row counts and an identical revenue total to the rupiah
(`295570000`). **Do not replace those calls with `Math.random()`** — a
hand-calculation against a dataset that changes on every run is worthless the
moment you re-run it.

> **The `295570000` above is Phase 8's figure and is no longer current.** The
> seed is still reproducible — that property holds — but the *value* changed:
> it had already drifted before D-92 (see D-93) and D-92 raised the shrinkage
> rates. Current figures are under *Current database state*. Reproducibility
> means "the same command gives the same database", not "this number is
> permanent"; changing the generator changes the numbers by design.

The data is deliberately **not uniform**: three branches at different volumes,
one branch with a 12% shrinkage rate, one staff member per shop awarding roughly
double the tickets, ~3% of sales voided, 30% walk-ins, weekend peaks. Flat data
would let a broken report look correct — every shop showing the same number
hides a grouping bug, and the §4.6 fraud ratio would have no outlier to detect.

`--reset-demo` deletes by `DEMO-` shop code, `DEMO-SKU-` prefix and a `[demo]`
name tag, in foreign-key order. Verified to leave exactly the base seed behind
(2 shops, 1 owner). Both flags **refuse to run** unless `DATABASE_URL` names a
`_dev`/`_test` database and `NODE_ENV` is not production — §10 warns about demo
data drifting into production, and a flag is easy to type on the wrong shell.

**The seed's FIFO consumer is a deliberate second implementation.**
`consumeFifoForDemo` does not call `services/inventory.ts`, because that engine
takes an `Actor` and the seed has no request context to give it; inventing a
fake actor would be worse. CLAUDE.md's "FIFO lives in one file" rule governs the
**application**. If you are tempted to import the seed's copy anywhere in
`src/`, that is the wrong instinct — call the real engine.

### D-62 · The cost gate is `every`, not `some` — and 33 passing tests missed it

**Read this before touching `assertCanSeeCost`.**

The gate intersects `canSeeCostForShop` across every shop in scope. A deliberate
`every` → `some` mutation **passed the entire 33-test suite**, because every
existing test used a single-shop scope, where the two operators are identical.

With `some`, a Purchasing manager assigned to **one** shop would read a cost
figure blended across shops they do not manage — a straight §7.5 violation
("their assigned shops ONLY").

`reports.test.ts` now has an explicit **mixed-scope** test: a manager assigned to
shopA only, handed a scope of `[shopA, shopB]`, must be refused — and the
single-shop scope they *are* entitled to must still pass, so the guard is
refusing the mix rather than refusing everything. Re-running the mutation with
that test present catches it.

**This is the strongest argument yet for CLAUDE.md gate 3's "seen to fail"
rule.** Three other mutations this phase were caught immediately; this one was
not, and it was the most dangerous of the four.

### D-63 · CSV is its own cost-leak surface, and its role test must match the service's

§15 requires no cost value in a manager or staff body "on any endpoint
**including CSV exports** and error payloads". A JSON DTO gate does nothing for
a CSV, which is built from whatever rows the caller hands over.

So `reports-export.ts` either calls a **cost-gated service** (which 403s before
any CSV exists) or emits cost-free columns from a cost-free query. There is
deliberately **no "strip these headers" helper** — that shape is what leaks.

**A real bug came out of this.** The liability export gated its valued columns
on `canSeeCost(actor)`, but `liabilityReport` populates those fields only for
`role === "OWNER"`. A Purchasing manager passes `canSeeCost`, so their CSV
carried *"Blended COGS per ticket"* and *"Estimated ticket liability"* headers
over permanently **empty cells** — an export promising a figure it can never
produce. Now gated on `role === "OWNER"`, matching the service exactly.

**The general rule:** when a DTO and its exporter both branch on role, they must
branch on the *same predicate*. Two nearly-identical gates that disagree is
worse than one, because the mismatch is invisible until someone reads the output.

Found by sweeping every endpoint as every role, not by reading the diff.

### D-64 · A page needs `asPageError`; a service throwing `AppError` is a 500 without it

**Found by loading every new page as each role — gate 5's rendering step.**

`/reports/prize-expense` and `/reports/stock-valuation` returned **500** to a
plain manager. The services correctly throw `AppError("FORBIDDEN")` (CLAUDE.md
rule 10), and `handleRoute` converts that for API routes — but a **page** has no
such wrapper, so the throw escaped as a server error.

`asPageError` has existed since Phase 1 for exactly this and simply was not
used. Every report page now ends its service call with `.catch(asPageError)`,
which also covers a foreign `shopId` in the query string (verified: 403, not
500).

**The lesson is D-33's, one layer up:** `typecheck` and `lint` both pass on a
page that 500s for half its intended audience. Only rendering it as each role
shows it. That step has now caught a defect in three consecutive phases (D-33,
D-34, this).

### D-65 · A verification query must use DATE LITERALS, not JS `Date`

**This one briefly made the ENGINE look wrong when the CHECK was wrong.**

The first independent SQL cross-check reported revenue of `291040000` against
the API's `295570000`, and tickets awarded `440711` against `444918`. Prize
expense, shrinkage, opex and balances all matched, which made it look like a
targeted bug in two metrics.

The cause: `businessDate` is a Postgres **`date`**, and binding a JS `Date`
through Prisma's `$queryRaw` sends a **`timestamptz`**. The comparison shifted
the boundary and silently dropped the final day (`6760000`) plus part of the
first. Re-running the identical query with **date literals** (`'2026-06-10'`)
returned `295570000.00` — matching the API exactly.

`verify-phase8.sh` therefore uses `$queryRawUnsafe` with interpolated date
literals throughout, and says so in a header comment. **Do not "tidy" that into
parameter binding.**

This is D-43's lesson with a new mechanism: a check that computes the wrong
thing is worse than no check, because it costs a session's confidence in
correct code.

### D-66 · Phase 8 shipped the engine and six screens, not all fifteen

**Owner decision, 8 Aug 2026.**

§9 lists **15 report screens**. Building all of them was offered and the owner
chose the narrower scope: the **full metrics engine** (every §9 metric), both
dashboards, CSV export for eleven reports, and **six screens** — Daily Sales,
Profit & Loss, Prize Expense, Stock Valuation, Liability, Attendance & Lateness
— plus Low Stock, which came free.

The reasoning: the engine is where money correctness lives and the screens are
repetition over it. Fifteen screens of shallow verification is worse than six
screens over an engine whose every metric has been checked against independent
SQL. The remaining screens are thin readers over functions that already exist
and are already proven — `salesByStaff`, `customerReport` and `expenseReport`
all have JSON endpoints and CSV exports today, with no screen.

**Remaining §9 screens** — Sales by Staff, Sales by Shop, Payment Method
Breakdown, Customer Spend Leaderboard, Prize Redemption, Shrinkage, Expense
Report, and the §8.9 attendance heatmap/trend charts — are recorded under
*Known issues / debts*. None needs new service work.

### D-67 · Recharts is in the stack but the dashboard uses inline SVG

§5.2 lists Recharts, and it remains the right tool for the richer report charts
(§8.9's heatmap and weekly trend). The dashboard's 30-day sparkline and the
revenue-by-shop bars are **hand-rolled inline SVG and divs** instead.

Why: the dashboard is a **server component** with no other client JavaScript.
Pulling in Recharts would have made it a client component and shipped a charting
bundle to a tablet on shop wifi, to draw a 30-point line. NF-1's budget is two
seconds on 4G.

This is not a rejection of Recharts — when Phase 8b or Phase 10 builds the
attendance heatmap, use it there. The rule of thumb: a chart with axes,
tooltips or interaction earns a library; a sparkline does not.

The top-8-plus-Others rule (§5.6) is enforced in **`dashboard.ts`**, not in the
component, so every consumer of that payload gets the same shape and nobody can
re-introduce a 30-series chart from the UI side.

### D-68 · The report filter bar, and what a page does with a bad URL

**Owner decision, 8 Aug 2026 — built immediately after Phase 8 closed.**

Phase 8 shipped seven report screens that read `?from=&to=&shopId=` but had no
control to set them; you typed the query string. `report-filters.tsx` adds
one-tap presets (Today · 7 days · 30 days · This month · Last month) plus two
native date inputs, and a shop picker. It lives in `ReportShell`, so all seven
screens gained it at once.

**It navigates by URL rather than holding data in client state.** The page
re-runs as a server component and the service re-resolves scope and permissions
from scratch. A client-side filter would have meant fetching report JSON into
the browser — exactly what the cost gate exists to prevent for a manager (§7.5).

**The shop picker offers "All shops" to an OWNER only.** §3.4 gives a manager one
shop at a time, so their picker lists their assignments with no aggregate
option. A multi-shop manager can switch between their own branches from the
report screen (owner decision — the alternative was making them change their
work session in Settings, which is worse for someone running two sites). This is
not where the rule is enforced: `resolveScope` validates every `shopId`
server-side and 403s a foreign one. The picker only avoids showing a control
that would fail.

**Presets anchor to the actor's BUSINESS date, never `new Date()`.** Before
04:00 the business day is still yesterday (§4.2, D-18), so a wall-clock "Today"
would ask for a date nothing is filed under yet — an empty report at 2am reads
as a broken screen rather than a boundary.

**Two real defects, both found by putting rubbish in the URL bar:**

| Input | Was | Now |
|---|---|---|
| `?from=banana`, `?from=2026-02-31`, inverted range | **500** — `asPageError` only converted `FORBIDDEN`, so `VALIDATION_FAILED` escaped | `rangeFrom` validates and falls back; an inverted range is **swapped**, not refused |
| `?shopId=no-such-shop` as OWNER | **200 with a page of zeroes** — reads as "this branch sold nothing" | **404** |

The second is the subtler one. `hasShopAccess` answers *"may you?"*, not *"is it
real?"*, and returns true for an owner on any string. `resolveScope` now checks
existence — but **after** the permission check, deliberately: reversing that
order would let a manager tell a real-but-foreign shop (403) from a fake one
(404) and probe which ids exist. Both orderings are pinned by tests.

An inverted range is swapped rather than rejected because it is almost always a
half-finished edit — the user changed "from" and has not yet changed "to". The
swap cannot produce a wrong number; it yields the range they described, the
right way round.

`asPageError` now maps `NOT_FOUND` → `notFound()` alongside `FORBIDDEN` →
`forbidden()`. Anything else is still rethrown on purpose: a service failing in
a way the page did not anticipate **is** a 500, and rendering "not found" for it
would hide a real bug.

Verified by 14 new checks in `verify-phase8.sh` and 2 new unit tests, with the
manager "All shops" check confirmed to go red under mutation.

### D-69 · Dashboard shop picker and expense filters — and a test that passed for the wrong reason

**Owner request, 8 Aug 2026.** Closes two of the three debts D-68 left open.

**The dashboard picker (§8.3) is a SEPARATE component from the report filters.**
`ReportFilters` carries a date range; the dashboard has no range to set —
§8.3 fixes its periods (today, this month, last 30 days). Reusing it would have
rendered date inputs that do nothing, which teaches people the controls are
unreliable. `dashboard/shop-picker.tsx` is owner-only and returns null below
two shops, because one shop is not a filter.

**The expense category chips are NOT the add form's category chips.** They look
identical and mean opposite things: one asks *"show me Rent"*, the other arms
the form to *record* a Rent expense. Sharing state would mean choosing a
category to record silently re-filtered the list out from under you. Separate
components, separate state — deliberately.

**Expense shop resolution has three cases**, and the middle one is the
interesting one:

| URL | Shows |
|---|---|
| explicit `?shopId=` | that shop |
| any *other* filter present | all the actor's shops |
| no filters at all | the work-session shop |

Someone filtering by "Rent" across the business expects every branch's rent,
not just the branch they happen to be sitting in. `listExpenses` still scopes a
manager to their assignments in SQL, so this widens the *view*, never the
*permission*.

§8.8's **"load more"** is now wired to the `nextCursor` the service has always
returned. It is a link that builds on the current search params, so paging
inside a filtered view stays inside it — appending a cursor to a bare path
would silently drop the filters and show the wrong second page.

Both screens sanitise dates from the URL the way D-68 taught: malformed,
impossible (`2026-02-31`) and inverted ranges all resolve rather than 500.

#### A mutation that did NOT go red, and why that was still worth knowing

The check *"a MANAGER gets no dashboard shop picker"* passed even after the
component's `isOwner` guard was deliberately removed. Not a broken check — a
check with **three** independent guards behind it:

1. the page passes `shops: []` for a non-owner,
2. the component returns null below two shops,
3. `DashboardView` renders it only when `isOwner`.

The test account was assigned to one shop, so guard 2 alone was enough. Only
after assigning that manager a second shop **and** removing guards 1 and 3 did
the check go red — which it then did, correctly.

**The lesson is not "the test was wrong".** It is that a fixture can make a
mutation unobservable, and a green result under mutation means *either* a weak
check *or* a redundant guard — you cannot tell which without looking. D-62 was
the first case; this is the second, with the opposite conclusion. Check the
fixture before rewriting the test.

### D-70 · Expense edit: what is editable, and the first real reason dialog

**Owner decisions, 8 Aug 2026.** Closes the last §8.8 UI gap. Receipt upload was
explicitly deferred — the endpoint and storage exist and are tested (D-57), and
the owner does not need the screen yet.

**Category, amount and note are editable. Shop and business date are not.**
That is `updateExpenseSchema`'s existing shape, and the owner confirmed it
should stay. A cost recorded against the wrong branch or the wrong reporting day
is not a typo — it is a different event. Silently moving the figure would change
a report someone may already have read, and §4.2 stamps `businessDate` once and
never recalculates it (D-18). **The fix for a wrong shop or date is
delete-with-a-reason and re-record**, which leaves both rows in the audit trail
and makes the correction visible rather than invisible.

The edit dialog says so on its face — *"the branch and date cannot be changed"* —
rather than leaving it to be discovered as two missing fields.

**The delete reason is a real dialog, not `window.prompt`.** Three other sites
(sale void, transfer cancel, attendance excuse) still use the prompt and are due
a Phase 10 sweep. The owner chose to build this one properly rather than add a
fourth instance of a known debt: **`edit-expense.tsx` is the shape that sweep
should copy.** The prompt cannot enforce the server's 3-character minimum, so a
short reason there costs a round trip and an error toast; this one disables the
button until the reason is long enough.

**`canEdit` is not a permission.** `updateExpense` and `deleteExpense` both
throw `FORBIDDEN` for a non-owner regardless of what the UI renders — verified
by calling both endpoints directly as a manager (403 each). The prop only avoids
offering a button that would fail.

Verified end to end on the demo data: an edit changes amount and category and
writes an audit row carrying the **old** amount; a 2-character reason is 422; a
real reason soft-deletes, the row survives flagged `isDeleted`, the reason lands
in the audit log, and the expense leaves the list and the totals. Two mutations
confirm the checks go red — dropping the audit write, and showing the control to
managers. The audit one was caught only by **D-43's empty-value guard**; a naive
comparison would have matched `""` against `""` and passed.

**One counting trap worth recording.** `grep -c` counts *lines*, not matches,
and this app renders its HTML on one line — so `grep -c 'aria-label="Edit '`
returned `1` for a page with nine edit buttons. Use `grep -o … | wc -l`. The
same mistake would understate any rendered-HTML assertion to exactly 1 or 0,
which looks plausible enough to accept.

---

## Decisions taken during Phase 9

### D-71 · Backups are NOT encrypted — a deliberate, informed choice

**Owner decision, 8 Aug 2026.**

§13.5 says backups contain customer names, phone numbers and password hashes,
and that if they leave the building they should be GPG-encrypted — *"If you
skip this, do it knowingly."* The owner was offered three options and chose to
skip it knowingly.

Recorded here so nobody "fixes" it later thinking it was an oversight, and so
the reasoning is available if the decision is ever revisited:

- The archives stay on a machine the owner physically controls, and the copies
  they make go to storage they control.
- A lost passphrase makes every backup permanently unreadable — including the
  one needed at 2am during the exact emergency backups exist for. That is a
  real, and irreversible, failure mode of the alternative.

**What was built anyway:** `restore.sh` has a marked place where decryption
belongs, and §13.4's `RCLONE_REMOTE` stays in `.env.example` unset. Turning
encryption on later is a change to `backup.sh` and that one spot in
`restore.sh`; nothing else in the system depends on the archive being plaintext.

**The consequence to keep in view:** the backup screen says, on its face, that
the archives are unencrypted and contain personal data. That sentence is not
decoration — it is what makes the choice visible to whoever handles the files
next. Do not remove it while this decision stands.

### D-72 · No automatic USB copy — and this makes the alert load-bearing

**Owner decision, 8 Aug 2026.**

§13.4 recommends a permanently attached USB drive that `backup.sh` copies to
automatically, on the grounds that it *"costs nothing, needs no discipline, and
covers the most likely failure by far — the internal disk dying."* The owner
declined it for now.

**Read this together with D-71, because the two compound.** With no encryption
*and* no USB copy, there is **no automatic protection at all** against losing
the entire history of the business. The only surviving control is the owner
manually copying an archive off the machine, and §13.4 is explicit that this
control's failure mode is *silent* — you discover the discipline slipped on the
day the machine dies (R-2).

That is why the following are **not** UI polish and must not be softened:

| Control | Why it is load-bearing now |
|---|---|
| One-tap download | §13.4: if it takes more than one tap it will not happen weekly |
| The copy log | It is what resets the reminder; without it the escalation is meaningless |
| Red at 14 days, **undismissable** | The last thing standing between the owner and total loss |
| The plain-language message | "Backup overdue" does not make anyone act; naming the days lost does |

If a USB drive is ever attached, `BACKUP_USB_PATH` is the shape to add: copy the
newest archive after `applyRetention()`, and never fail the backup itself if the
drive is missing.

### D-73 · Retention refuses to delete rather than risk deleting everything

§13.2 says keep 7 daily backups and *"never delete your way to zero"*.
`applyRetention()` implements that as a hard floor: if pruning would leave fewer
than `MIN_SURVIVING_BACKUPS` (3) archives, it deletes **nothing** and reports
`skippedForSafety`, which the CLI and the screen both surface.

The failure this prevents is not the common case — it is a bug in the sort order
or the keep count clearing the shelf, discovered on the day an archive is
needed. Keeping too many backups costs disk. Keeping none costs the business.

**The test for this initially proved nothing, and that is worth recording.**
The first version re-implemented the keep/delete decision inside the test file
and asserted against its own copy. Deleting the safety floor from the shipped
function left all 13 tests green — D-62's lesson, reproduced exactly. The test
now calls the real `applyRetention()` with `BACKUP_DIR` pointed at a temp
directory via `vi.resetModules()`, and the same mutation fails it immediately.
**If you refactor retention, re-run that mutation.**

### D-74 · The production image needs postgresql-client-16 SPECIFICALLY

**A production-only defect that every other gate passed. Read this before
touching the Dockerfile.**

`node:22-bookworm-slim` + `postgresql-client` installs version **15**. The
compose stack runs `postgres:16-alpine`. `pg_dump` refuses to dump a server
newer than itself:

```
pg_dump: error: aborting because of server version mismatch
detail: server version: 16.13; pg_dump version: 15.18
```

So **every nightly backup would have failed in production**, silently, while
working perfectly in development — dev uses Homebrew's pg_dump 16. Typecheck,
lint, 180 unit tests, `verify-phase9.sh` and even `docker compose build` all
passed with this in place.

The Dockerfile now installs `postgresql-client-16` from the PGDG apt repository.
Verified by running `pg_dump` **inside the built image** against a real v16
server, not by reading the Dockerfile.

**The general lesson, which is D-33's in a new place:** a build that succeeds
proves the image builds, not that the tools inside it work. When a phase
depends on an external binary, execute it in the image.

**If Postgres is ever upgraded to 17, this pin moves with it.** A mismatched
client is silent until the backup you need does not exist.

### D-75 · Alerts are re-synced on read, not only by cron

`SystemAlert` is written by the background jobs, but the owner **dashboard**
reads that table while the backup API computes staleness live. Between crons the
two could disagree — the settings page showing a red warning while the dashboard
showed nothing until 02:00.

`syncBackupAlerts()` therefore runs when the backup screen is rendered and after
both mutations (taking a backup, recording a copy), so tapping "I copied this
off-machine" clears the red banner on the same tap rather than leaving the owner
wondering whether it registered.

**Found by `verify-phase9.sh`, not by any unit test** — the check asserts the
warning text appears in the rendered *dashboard* HTML, which is the screen §13.4
actually relies on. A check that only asked the API would have passed.

The alert-sync call is deliberately wrapped in a `.catch()` that swallows: this
is the page someone opens when they are already in trouble, and alert
bookkeeping must never be the reason it fails to render.

### D-76 · Rate limiting was already built; the audit log had no reader

§16's Phase 9 line asks for "rate limiting, audit log viewer". Only one of those
was missing.

**Rate limiting already exists** in `src/server/auth/auth.ts` from Phase 1: 5
sign-in attempts per 15 minutes with a 100-request general window (§5.4). A
second mechanism was deliberately **not** added — two rate limiters is two
sources of truth about who is throttled, which is the drift D-4 warns about for
permissions. If a specific endpoint ever needs its own limit, add a
`customRules` entry there rather than a new layer.

**The audit log had no reader at all.** `writeAudit` has been recording rows
since Phase 1 and nothing ever read them back, so the trail existed but could
not be consulted — which is most of the point of §4.16. `services/audit-log.ts`
and `/settings/audit-log` close that: owner-only, filterable by entity, paged by
cursor.

It is **read-only by construction**. There is no update or delete anywhere in
that file or in `audit.ts`, and no retention job for audit rows. §4.16 requires
immutability, and a "tidy up old audit rows" helper is precisely how a trail
stops being evidence. `POST` and `DELETE` on the endpoint return 405.

### D-77 · The business-day hour is a two-step change, unlike every other setting

§8.10 puts the cutoff under Owner → System, which is where it now lives. It is
the only control on that screen that needs a confirmation step.

Everything else there changes what the app does next. This changes what past and
future data *mean*: `businessDate` is stamped once and never recalculated
(D-18), so moving the hour puts a permanent seam in the reporting history with
nothing in the app to mark where it falls. The confirmation names that
consequence in full rather than asking a bare "are you sure?", which trains
people to tap through.

**Deliberately not offered: a "restamp history" option.** Recomputing
`businessDate` across existing sales, ledgers, attendance and expenses would
silently rewrite every historical report the owner has already read.

The change is audit-logged with **both** the old and new hour, so "revenue for
the 9th looks odd" has an answer if someone moved the cutoff on the 9th.

### D-78 · A Phase 8 check was asserting a fixture, and Phase 9 exposed it

`verify-phase8.sh` asserted `alerts.backupIsStale === "true"` as a **constant**.
That passed for one reason only: no backup had ever run, so the flag was
permanently true. The moment Phase 9 took a real backup the check failed —
with nothing broken.

It now derives the expectation from `/api/health`'s `lastLocalBackupAt` and
§13.2's 36-hour rule, so it tests the **rule** rather than the state the
database happened to be in.

**The mutation story here is worth more than the fix.** Breaking
`backupIsStale` to a hard `false` still passed, because with a fresh backup
both sides computed "not stale" and `false === false`. Only after backdating
the `BackupRun` rows to 72 hours did the same mutation fail correctly.

That is **D-69's lesson repeating**: a green result under mutation means either
a weak check or a fixture that makes the mutation unobservable, and you cannot
tell which without looking. Check the fixture before rewriting the test. It is
also a caution about acceptance scripts generally — a check that hardcodes an
expected value ages into a check that tests nothing, and it does so silently.

---

## Decisions taken during Phase 10

### D-79 · The three remaining `window.prompt` sites share ONE dialog

**Phase 10's first sweep.** Sale void, transfer cancel and attendance excuse all
moved to `src/components/reason-dialog.tsx`, modelled on D-70's
`expenses/edit-expense.tsx`.

**One shared component rather than three copies of D-70's shape.** Three copies
would be three places for the minimum-length rule to drift, and the next change
would miss one — the same argument D-32 makes for keeping the ticket guard in
one place. `edit-expense.tsx` stays inline because its dialog does double duty
as the *edit* form; the shared component only handles reason-then-confirm.

**The debt entry was WRONG about one of the three, and this matters.** It said
all three needed the server's 3-character minimum. Checking the schemas:

| Site | Server rule |
|---|---|
| Sale void — `voidSaleSchema` | `min(3)` |
| Transfer cancel — `cancelTransferSchema` | `min(3)` |
| **Attendance excuse — `editAttendanceSchema`** | **`note` is `.optional()`** |

So the excuse dialog's 3-character requirement is a **UI rule**, not a mirrored
server constraint, and `reason-dialog.tsx` says so in its header. Do not "tidy"
that into a claim the server enforces it, and do not relax the other two, where
it genuinely does. An excuse is also a *correction* rather than a reversal, so
it confirms in the `default` button variant — colouring an approval red misreads
what the owner is doing.

What the prompt structurally could not do, and this does: enforce the minimum
**before** the round trip. Verified in a browser at the boundary — empty and
`ab` leave the button disabled, `abc` enables it, and **five spaces stay
disabled** because the check trims first. That last case is a real bypass a
naive `length >= 3` would have allowed.

### D-80 · The PWA manifest is `app/manifest.ts`, and it is NOT offline support

§8.11 calls the manifest optional-but-cheap. Built as a typed
`src/app/manifest.ts` rather than a static `public/manifest.json` so Next serves
it at `/manifest.webmanifest` with the right content type and the fields stay
typed.

Icons are **SVG**, drawn in-repo (`public/icon.svg`, `icon-maskable.svg`). No
binary asset, and nothing is fetched at build time — the same constraint that
keeps `next/font/google` out of `layout.tsx` (D-7). The maskable variant has
deliberately *smaller* artwork inside the 80% safe zone, because Android crops
it; a re-crop of the same file would clip.

**§8.11 is explicit that a manifest does not add offline support, and the file
says so where someone would go looking.** There is no service worker and no
cache. A staff member whose wifi drops sees exactly what they see in a browser
tab. Offline sales would need real conflict rules for money and are out of scope
for v1 (§1.5) — do not let "we have a manifest" become "we work offline".

iOS ignores the manifest's icon array entirely, so `appleWebApp` metadata is
declared separately in `layout.tsx`.

### D-81 · Clock-out shows the shift's end time instead of nagging

**Owner decision, 9 Aug 2026.** `POST /api/attendance/clock-out` had existed and
been tested since Phase 6 with **nothing calling it**, so a shift could be
started and never finished — the "looks unfinished on the team screen" debt.

The owner was offered three placements and chose none of them, pointing out
instead that *the hour is set per shift*. That is the better answer, and it came
from the data: `Attendance.shiftId` links each record to its shift, and
`Shift.endTime` is stored, so the app already knows when each person is
scheduled to finish. The card shows that (`P10 ClockOut Shift ends 17:00`).

**So there is deliberately NO second banner.** §4.13 specifies exactly one — the
red clock-in banner — and a persistent amber "still clocked in" bar would
compete with it for the same strip while eating vertical space §8.11 wants the
sale screen to keep. Information beats a nag.

**`endTime` is read LIVE, not snapshotted.** There is no `shiftEndAtCapture`
column to match `shiftStartAtCapture`, and none was added: the end time here is
context for a decision being made *now*, never used to judge a past record, so
§4.14's "editing a shift must not rewrite past lateness" still holds.

**The note is optional, matching `clockOutSchema`** — which is why this is NOT
the shared `ReasonDialog` (D-79). That component's whole shape is "you may not
confirm until the reason is long enough"; here you always may. A blank note
sends `{}`, never `{"note":""}` — verified by intercepting the request in the
browser, and the row stored `null`.

History rows now read `09:02 → 17:16`, or `→ still in` while open. Collapsing
those two is what made the screen look unfinished in the first place.

### D-82 · Phase 10 built SEVEN report screens, and two needed new services

**Owner decision, 9 Aug 2026.** D-66 left nine §9 screens unbuilt and *Known
issues* claimed they "all have a working service **and** a CSV export today —
they need only a page". **That was true for five of them and wrong for two:**

| Screen | What actually existed |
|---|---|
| Sales by Staff · Sales by Shop · Payment Method · Customer Leaderboard · Expense Report | service ✅ export ✅ — genuinely page-only |
| **Shrinkage** | only a single `shrinkageExpenseValue` **total** inside `prizeExpenseReport`; no breakdown, no export |
| **Prize Redemption** | **no report service at all** — only `listRedemptions`, an operational paged list |

The owner chose to build all seven rather than defer the two. The attendance
heatmap and weekly trend (§8.9) stay deferred — they need Recharts, which D-67
reserves for exactly that job.

**`shrinkageReport()` splits OPNAME_LOSS from DAMAGE, and that split is the
point.** §9 keeps shrinkage out of prize expense because "mixing it into prize
expense hides theft"; splitting *declared* damage from *discovered* opname loss
is the same argument one level down. Damage has a name against it at the moment
it happened. An opname loss is what a count found missing with nobody
accountable — so a branch whose shrinkage is nearly all opname loss is the one
to visit, and merging the columns destroys that signal. Owner and Purchasing
only, via `assertCanSeeCost`.

**`prizeRedemptionReport()` is deliberately NOT cost-gated at the top.**
Quantities and ticket spend are operational facts a manager needs to restock,
and §7.5 restricts *cost*, not activity. The cost is resolved per-caller
instead: `cogs` comes back **`null`** — never `0`, which would be
indistinguishable from a real zero — and the restricted query never names the
cost column.

`tickets` reads `RedemptionLine.ticketCostTotal`, which is **already** qty ×
ticketCostEach. Multiplying by qty again squares the quantity; the mutation
below proves the test catches it.

### D-83 · `canSeeCostForScope` — the non-throwing twin, and it must stay `every`

`prizeRedemptionReport` needs "may this caller see cost?" as a **boolean**, not
a throw, so `assertCanSeeCost` was refactored to delegate to a new exported
`canSeeCostForScope`.

**It uses `every`, not `some`, for exactly D-62's reason** — with `some`, a
Purchasing manager handed a mixed scope reads a figure blended across shops they
do not manage. The two functions now share one implementation so they *cannot*
drift, which is stronger than the comment that used to guard it. The mixed-scope
test from D-62 still covers it: an `every → some` mutation fails it.

### D-84 · A cost leak the output-level tests could not see

**The most valuable thing this phase found. Read it before touching a
restricted query.**

`prizeRedemptionReport`'s restricted branch runs a **separate query that does
not select `cogsTotal`**, per §7.5's "the restricted builder physically does not
read the cost columns — do not implement this by deleting keys from a full
object".

A mutation that made the restricted branch select `cogsTotal` anyway **passed
every test in the file**, because `withCost` still nulled the figure on the way
out. The downstream guard hid the broken upstream one. That is D-62's shape
repeating: a green suite under mutation means either a weak test or a redundant
guard, and you cannot tell which without looking.

The fix is a test that asserts on the **query result**, not the output —
`redemptionLinesForScope` is exported solely so it can be called directly. With
it, the same mutation fails immediately (`expected 7777 to be null`). **If you
refactor that function, re-run the mutation.**

### D-85 · Two `Number()`-on-money slips, caught before commit

Both new "share of total" columns were first written with
`Number(revenue) / total`, which violates CLAUDE.md rule 5 — `Number()` on a
14-digit Decimal is lossy *before* the divide. Both are now
`new Prisma.Decimal(x).div(total)`.

Worth recording because the pull toward it is strong on a *display-only*
percentage, where the value is never stored. The rule has no display exemption,
and a figure someone reads off a screen and types into a spreadsheet is not
display-only in practice. The only JS-number arithmetic on these pages is over
marble and ticket **counts**, which are integers.

### D-86 · Screens whose API 404s, found by the role sweep

The seven screens shipped, typechecked and rendered — and `sales-by-staff`,
`sales-by-shop` and `expenses` had **no JSON report registered**, so
`/api/reports/sales-by-staff` returned 404 while the screen worked. The CSV
registry already knew two of those names; the JSON registry did not.

Nothing in typecheck, lint or the tests could see this: the screens call the
*services* directly, not the API. It surfaced only from sweeping every report
name as every role. §7.8 gives every §9 report its own address, and an asymmetry
where a name exports but cannot be fetched is how the next person wiring up a
screen loses an afternoon. `verify-phase10.sh` now checks all six names.

**This is D-33/D-34/D-64's lesson in a fourth consecutive phase.**

### D-87 · `costOnly` on the reports index — D-34 in its "hidden" form

Shrinkage is cost-bearing but **not owner-only**: a Purchasing manager may read
it for their own shops. Marking it `ownerOnly` in the index would have hidden a
screen they are entitled to — D-34's bug wearing a different coat, since a
hidden door and a 403 are the same outcome for the person who needs it.

So the index gained a `costOnly` flag filtered through **`canSeeCost`**, the
same predicate the services use, and the two therefore cannot disagree.
Verified three ways: the owner and a Purchasing manager are offered Shrinkage, a
plain manager is not, and flipping `costOnly` to `ownerOnly` turns
`verify-phase10.sh` red.

### D-88 · Loading skeletons echo the layout; the 404 page finally exists

Every report page is `force-dynamic` and runs real aggregates, and Next renders
**nothing** until the server component resolves. A blank screen for a second
reads as broken and gets the page reloaded, which starts the query again.

`loading.tsx` sits at the **reports segment root**, so all fifteen screens get
it from one file rather than fifteen that drift. The blocks are a *layout echo*,
not a spinner, so nothing jumps when data lands.

Separately: `notFound()` had been called from three places since Phase 8 (D-68's
`asPageError` among them) with **no `not-found.tsx` to render it**, so those
paths fell through to Next's stock page with no way back into the app.
`src/app/not-found.tsx` now matches `forbidden.tsx`'s tone. The string "404"
appears nowhere on it — it means nothing to the staff member reading it.

### D-89 · "Printable receipts" in §16's Phase 10 line was NOT built

§16's Phase 10 scope names "printable receipts". **CLAUDE.md's do-not-reopen
table says "No receipt printing in v1 — on-screen confirmation only."**

CLAUDE.md wins: it is the higher-precedence document, and the decision is listed
among those explicitly not to reopen. Flagged to the owner rather than silently
skipped, and recorded here so a future reader finds the contradiction already
resolved instead of re-litigating it. If receipts are ever wanted, that table is
the entry to change first.

### D-90 · `verify-phase10.sh` was proven by four mutations — one of which passed

D-43's rule again. 56 checks passed first run, which is when to be suspicious:

| Mutation | Result |
|---|---|
| `withCost = true` — leak cost to a plain manager | **caught** by 3 checks (JSON, per-item, CSV) |
| `costOnly` → `ownerOnly` — hide Shrinkage from Purchasing | **caught** |
| every → some in `canSeeCostForScope` | **caught** by D-62's mixed-scope test |
| **DAMAGE misfiled as OPNAME_LOSS** | **PASSED — the script was blind to it** |

The fourth is the one worth reading. The check compared
`opnameLoss + damage == totalShrinkage`, and **a reclassification does not
change a sum**. Worse, the demo dataset has 12 `OPNAME_LOSS` movements and
**zero `DAMAGE`**, so the bug was unobservable in the fixture as well.

Both halves had to be fixed: the check now recomputes the split from the
**database in independent SQL** and compares it field-by-field, so it catches
misclassification in either direction regardless of what the seed contains. The
same mutation now reports `got: 0|93500` against a real `93500|0`.

**D-69's lesson, third occurrence:** a green result under mutation means either
a weak check or a fixture that cannot express the bug. Check the fixture before
rewriting the test — and here it was genuinely both.

---

## Post-phase debt work — 9 Aug 2026

Not a phase. Three items taken off the **Known issues / debts** table while the
hands-on acceptance passes (Phases 4, 6, 9, 10) wait on real devices. Chosen
deliberately because they close gaps in the safety net **without adding screens**
— new UI landing days before the one-branch pilot is new risk during exactly the
week the pilot exists to de-risk.

### D-91 · The §15 unit tests that had no home: business date and phone

The debts table flagged these as "add each as its phase comes up", with the
business-date cases called out as worth backfilling sooner. They are now in.

`src/lib/__tests__/business-date.test.ts` (19 tests) covers §15's four named
boundaries (03:59, 04:00, 23:59, 00:01), the work-session/sale agreement case
§15 words explicitly, month/year/leap-day rollback, and the UTC-midnight shape
the Postgres `DATE` column depends on. `phone.test.ts` (24 tests) covers §15's
four spellings plus the punctuation staff actually type.

**Two things these tests assert that are worth knowing about:**

1. **The `businessDateFor` "disagreement" case is deliberate.** A clock-in at
   03:55 and a sale at 04:05 file under *different* business dates. That is the
   rule working, not a bug — but the §15 pair on its own ("session and sale ten
   minutes later agree") would pass against a function that returned a constant,
   so the opposite side is pinned too.
2. **Phone tests check BOTH failure directions.** Under-collapsing splits one
   customer's balance across two records; over-collapsing *merges two real
   customers*, which is worse and less visible. A normaliser that truncates
   passes every "these spellings match" test ever written.

**Proven by mutation** (CLAUDE.md gate 3 — a test you have not seen fail proves
nothing). Four mutations, all caught, all reverted:

| Mutation | Result |
|---|---|
| `hour < dayStartHour` → `<=` (cutoff off-by-one) | **caught** by 5 checks |
| compute from UTC parts, ignoring the timezone | **caught** by 6 checks |
| drop the `00` international-prefix strip | **caught** by 2 checks |
| truncate the key to 12 digits (over-collapse) | **caught** by 2 checks |

These are pure-function tests — no database, no fixtures — so they cost ~14ms
and cannot flake. Suite is now **236 tests, up from 193.**

### D-92 · The demo seed writes DAMAGE, and its shrinkage rates were far too low

D-90 asked for "a few DAMAGE rows so the fixture can express the bug". Doing it
surfaced a second, larger problem.

**The DAMAGE split reuses an existing `rng` draw.** D-61 makes the seed
reproducible on a fixed seed, so a *new* random call inside the day loop would
shift every subsequent draw and change every documented figure. The type is
therefore keyed off the `qty` already drawn (`qty === 3` → `DAMAGE`), which
costs no extra randomness. Verified: the sale/redemption/attendance counts are
byte-identical with and without the split.

**Then the rates.** The old rates (0.02 / 0.02 / 0.12 per day over 60 days)
produced **five shrinkage movements in the entire dataset**, and one branch had
none at all — far too thin for the §9 shrinkage report to be judged against,
which is what §16 accepts Phase 8 on. Raised to 0.15 / 0.15 / 0.4, giving 39
movements with both kinds at every branch and DEMO-C still standing out.

**This is the fix that mattered, and here is the proof.** D-90's fourth
mutation — DAMAGE misfiled as OPNAME_LOSS — was the one that *passed* against
the old fixture. Re-run against the new one:

```
MUTATED  -> opnameLoss=373500 damage=0
RESTORED -> opnameLoss=168000 damage=205500
```

Under the old zero-DAMAGE fixture both readings were `damage=0` and the bug was
invisible in the data. `verify-phase10.sh`'s independent-SQL recomputation
**stays** — it is the stronger check and catches misclassification in either
direction regardless of the seed — but the fixture can now express the bug on
its own.

### D-93 · The documented demo figures were already stale before this work

Found while checking whether D-92 had disturbed the fixed seed. It had not —
**the numbers in this log were wrong beforehand.** Baseline on unmodified code
was 1701 sales / 211 redemptions / 501 attendance / 26 expenses, against the
1711 / 193 / 496 / 27 recorded under *Current database state*. Something in an
earlier phase changed the draw sequence and the table was never updated.

Nothing broke, because **`verify-phase8.sh` never hardcodes these figures** — it
computes every assertion relationally (cash + EDC reconciles to revenue, gross
profit = revenue − prize − shrinkage) and checks the CSV against the JSON. That
is why the drift went unnoticed for a phase, and it is an argument for keeping
verification relational rather than pinning constants.

*Current database state* is updated below with figures taken from the database
after this reseed. **Treat a hand-calculation written against the old numbers as
void.**

### D-94 · `verify-phase10.sh` depends on shop assignments that `--reset-demo` destroys

Reseeding made four Phase 10 checks fail with **409**, which reads as a
permission bug and is not one. `--reset-demo` deletes the DEMO shops and
recreates them with new ids; the `p8mgr` / `p8purch` / `p8staff` accounts were
assigned to the old ids **by hand during Phase 8**, so they came back with no
shops, no `defaultShopId`, and therefore no work session. The body says it
plainly: `NO_WORK_SESSION`, not `FORBIDDEN`.

Reassigned through `PATCH /api/users/:id` (`p8purch` → DEMO-A only, per §7.5's
"cost at my shops, 403 at yours" criterion). All 57 checks pass again.

**The debt this leaves:** the fixture accounts are set up manually and the
scripts assume they exist and are assigned. Anyone who runs `--reset-demo` will
hit this and may read it as a regression. Either `verify-phase8.sh` should
create and assign them the way `verify-phase4.sh` creates `purchaser1`, or the
demo seed should own them. Added to the debts table.

**Read the error body before believing a status code.** A 409 that looks like a
403 cost more time here than the fix did.

### D-95 · `verify-phase8.sh` has three stale checks — Phase 8 is no longer green

**Found by re-running it after the D-92 reseed. This is the most important
entry in this batch, because Phase 8 is marked ✅ and currently is not.**

`verify-phase8.sh` was last touched during Phase 9. Phase 10 (`b509d4c`) then
changed behaviour it asserts, and **nobody re-ran it.** Three checks now fail:

| Check | Gets | Why |
|---|---|---|
| `a nonexistent shopId is 404, not a silent zero` | 200 | D-88 added `src/app/not-found.tsx`. `notFound()` now renders that page, and the response carries **200** with 404 *content* rather than a 404 status. |
| `  and a MANAGER gets 403 first, so ids cannot be probed` | 200 | Same cause. |
| `the OWNER sees an edit control on the list` | no | The probe expense is created at **DEMO-A**; the owner's work session is at **BR-1**, and `/expenses` with no filters shows the work-session shop only. Verified: with `?shopId=<DEMO-A>` the control appears (9 of them). |

**Two of these are a real regression and one is a bad assertion, and they need
different fixes:**

- **The 404s.** A page that renders "not found" under a **200** is wrong beyond
  this script: it tells a crawler, a monitor and any client-side error handling
  that the request succeeded. R-4's intent — that a manager cannot probe shop
  ids for existence — also degrades if both the "exists" and "doesn't exist"
  answers are 200 to a client reading status codes. This wants a real fix in
  the page (an explicit 404 status), not a relaxed check.
- **The edit control.** The check is shop-blind and only ever passed because
  the owner's session happened to sit at the probe's shop. The permission
  itself is correct and the three server-side checks around it still pass
  (`OWNER can edit`, `MANAGER is 403 on PATCH`, `MANAGER is 403 on DELETE`) —
  which is exactly why hiding a button is not a permission (CLAUDE.md #4). Fix
  the assertion to request `?shopId=$EDIT_SHOP`.

**Not fixed in this batch, deliberately.** The 404 change touches page-level
error handling across every screen that calls `notFound()` — that is a code
change with its own blast radius, and this batch's remit was tests, fixtures
and docs, with the pilot imminent. It is written up here rather than silently
left, and added to the debts table.

**Phase 8's row stays ✅ in the status table** because its §16 criterion (every
§9 metric matches a hand-calculation) is unaffected — all the metric,
reconciliation and cost-gate checks still pass. What broke is the *script*, in
two places, plus one genuine cross-cutting defect in 404 status codes.

**The lesson, and it generalises:** a verification script is only true as of the
last time it ran. Phase 10 was accepted on `verify-phase10.sh` alone, and
nothing re-ran the earlier phases' scripts — so a Phase 10 change quietly
invalidated two Phase 8 assertions. **Before the pilot, run every
`verify-phase*.sh` in order once**, on a freshly reset database, and treat that
as the real go-live gate rather than any individual phase's green tick.

---

## Post-phase debt work — 9 Aug 2026 (second batch)

The three items D-95 left open, taken in order. Not a phase. The go-live gate
D-95 asked for was run at the end and is now green.

### D-96 · The 200-status defect was `loading.tsx`, not `not-found.tsx`

**D-95's diagnosis was wrong in both halves, and the wrong fix would have been
applied by anyone who trusted it. Read this before touching a `loading.tsx`.**

D-95 recorded the cause as D-88's `not-found.tsx` and the blast radius as
"every page that calls `notFound()`". Reproducing it first showed otherwise:

| Path | Status | Verdict |
|---|---|---|
| `/customers/[id]` bad id → `notFound()` | **404** | always correct |
| `/customers/[id]/redeem` bad id | **404** | always correct |
| `/reports/*?shopId=ghost` | **200** | wrong |
| `/dashboard?shopId=ghost` | **200** | wrong |

The cause is the *other* half of D-88: **`loading.tsx`**. A segment with one is
wrapped in a Suspense boundary, and Next flushes the shell — headers included —
as a **200** the moment the page suspends. That happens in the `(app)` layout,
before any page code runs. A later `forbidden()` or `notFound()` still renders
the right screen; it can no longer change the status.

**Proven by the cleanest available experiment:** adding a `loading.tsx` to the
working `/customers/[id]` page flipped it 404 → 200, and removing it restored
404. Nothing else changed.

**D-95 also missed the worse half.** It only mentions the 404s. `forbidden()`
is affected identically — a manager requesting another branch's report got the
**403 page under a 200**. That is the R-4 property ("ids cannot be probed")
degrading for any client that reads status codes, and it was live on every
report screen and the dashboard.

**A page-level fix is structurally impossible.** The obvious one — validate
`shopId` before the slow queries — was built and *runs* (the shop-existence
query fires) but changes nothing, because the layout suspends first. Anything
inside the page is already too late. That attempt was discarded, not shipped.

**What was done (owner decision, 9 Aug 2026).** Both `loading.tsx` files
deleted. Three options were put to the owner:

| | |
|---|---|
| **A — delete them** *(chosen)* | One line, correct statuses everywhere, verified. Costs the skeletons. |
| B — explicit `<Suspense>` inside each page | Keeps both, but ~16 pages restructured days before the pilot. |
| C — document and defer | Screens already render correctly; only status codes are wrong. |

A now, B after the pilot. A correct 403 beats a skeleton, and B is the wrong
shape of risk during pilot week. **`components/skeleton.tsx` is deliberately
kept with no callers** — B needs it, and its header now explains why it must
not be deleted as dead code.

Verified across **16 pages × 4 roles, 32 checks**: bad `shopId` → 404 for an
owner, 403 for a manager (permission before existence, so ids stay unprobeable),
valid requests still 200, and every role gate unchanged. The two
`verify-phase8.sh` 404 checks go red when `loading.tsx` is restored and green
when it is removed — confirmed in both directions.

### D-97 · `/reports/tickets-awarded` never checked that the shop was real

Found by the 32-check sweep, not by any script. It is a Phase 3 page that
predates `resolveScope`, so it filtered on `shopId` and simply found nothing —
an owner's typo rendered a calm, empty report reading as "no tickets were
awarded at this branch" rather than "no such branch". D-68 fixed exactly this
shape everywhere else and this page was never revisited.

Owner-only, so it is a truthfulness bug rather than a permission hole. Now
`notFound()` when the id does not exist.

### D-98 · Two verification scripts were computing the wrong thing

Both found by the full sequential run, and **both made correct code look
broken** — D-65's lesson twice more.

**`verify-phase8.sh` net profit used `Number()` on money.** With operating
expenses at `1305460951.11`, `gross − opex` evaluates to `…951.1099999` in
float, and the check compared with `===`. It reported a mismatch against an
engine that was exactly right — §4.1's own bug, reproduced inside the check
meant to catch it. Now compared with `Prisma.Decimal`; verified it still
catches a one-cent error.

**The liability tolerance was a fixed constant that did not survive growth.**
`blendedCogsPerTicket` is displayed at 4dp while the engine multiplies at full
precision and rounds once — the correct order. Re-multiplying the display value
can therefore never match exactly. The old `1e-6` relative bound passed at
~300k outstanding tickets and failed at 377k with nothing wrong (the gap was
Rp 17.86 on Rp 9.95M). The bound is now **derived** from what the rounding can
actually produce — `0.00005 × outstandingTickets + 1` — so it scales with the
data. Verified it still catches a 0.1% engine error.

### D-99 · `verify-phase1.sh` was unrunnable, and nobody noticed for nine phases

It hardcoded `D=/private/tmp/…/-Users-ricky-redlight/79ef0799-…/scratchpad` —
one long-dead session's temp directory — and `cd`-ed to `/Users/ricky/redlight`,
the project's former name. Every cookie jar and response file silently failed to
write, so **all 21 checks reported red with nothing broken.** The other nine
scripts all use `mktemp -d`; this one never did.

Now `mktemp -d` and a path derived from the script's own location.

**It was also not re-runnable**, which only a second consecutive run exposes:
the forced first-login password change can be observed once per seeded
database, and creating `manager1`/`staff1` returns 409 the second time. Both now
report a **skip** (a yellow `•`) rather than a failure, with the first-run
assertion still made when the database is genuinely fresh. Three checks that
looked like regressions were neither.

### D-100 · The go-live gate is green — 469 checks, three consecutive runs

D-95 asked for every `verify-phase*.sh` in numeric order on a freshly reset
database, as the real gate. Done, on `marblehouse_dev` reset and reseeded with
`--demo`:

```
verify-phase1 … verify-phase10      469 ✓   0 ✗   3 skips
```

Repeated **three times back to back** with identical results, which is the
property that matters — the first run passed and the *second* found four
problems (D-98's two, D-99's two). A gate you can only run once is not a gate.

Also green: typecheck, lint, **236 unit tests**, and `docker compose build`.

**D-94's debt bites exactly as predicted.** A reset destroys the `p8mgr` /
`p8purch` / `p8staff` accounts, and they must be recreated through
`POST /api/users` *and* have their forced password change completed (which is
what appends the trailing `x`). Until the demo seed owns them, that is a manual
step before phases 8 and 10 — budget for it.

**One thing to know for the next full run:** `verify-phase1.sh` changes the
owner's password to `OwnerRealPass2026!`, while `verify-phase8.sh` defaults to
`Phase8Owner2026!`. Export `OWNER_PASSWORD='OwnerRealPass2026!'` for phases
8–10 after running phase 1, or they fail at login and look like a permission
regression.

---

## What Phase 10 built

```
src/components/
  reason-dialog.tsx      D-79. THE shared reason-then-confirm dialog. minLength
                         is per-site because the SERVER rules differ — read the
                         header before changing it.
  skeleton.tsx           D-88. Skeleton + ReportSkeleton. Layout echo, not a
                         spinner.

src/app/
  manifest.ts            D-80. §8.11's PWA manifest. NOT offline support.
  not-found.tsx          D-88. The 404 that notFound() has needed since Phase 8.
  layout.tsx             TOUCHED: manifest link + appleWebApp metadata.

public/
  icon.svg               D-80. Drawn in-repo; no binary, no build-time fetch.
  icon-maskable.svg      Smaller artwork inside Android's 80% safe zone.

src/app/(app)/attendance/
  clock-out-card.tsx     D-81. The caller POST /api/attendance/clock-out never
                         had. Shows the shift's scheduled end instead of nagging.

src/app/(app)/reports/
  loading.tsx            D-88. One file; every report screen inherits it.
  sales-by-staff/ sales-by-shop/ payment-methods/ customers/ expenses/
  shrinkage/ prize-redemption/     The seven new §9 screens (D-82).
  page.tsx               TOUCHED: + costOnly (D-87) and the seven entries.

src/app/(app)/dashboard/loading.tsx    D-88.

src/server/services/
  reports.ts             + shrinkageReport, prizeRedemptionReport (D-82),
                         canSeeCostForScope (D-83), redemptionLinesForScope
                         (D-84 — exported ONLY so its query can be tested).
  reports-export.ts      + shrinkage and prize-redemption CSV builders.
  attendance.ts          TOUCHED: attendanceStatus now returns shopName and the
                         shift's endTime (D-81).

src/app/api/reports/[name]/route.ts    TOUCHED: + shrinkage, prize-redemption,
                         sales-by-shop, sales-by-staff, expenses (D-86).

src/components/app-shell.tsx   TOUCHED: shop switcher raised 32px → 44px.

scripts/verify-phase10.sh      57 checks. Proven by four mutations (D-90).
```

**No migration.** Phase 10 reads; it adds no columns, so PRD §6 still matches
`prisma/schema.prisma`.

**§16 criteria:**

| Criterion | Status |
|---|---|
| Loading and empty states | ✅ D-88 |
| Error copy in plain language | ✅ 404 page added; service copy was already plain |
| PWA manifest | ✅ D-80, verified served with the right content type |
| Printable receipts | ⛔ **Deliberately not built — D-89.** CLAUDE.md forbids it in v1 |
| **Responsive pass on real devices** | ⬜ **OUTSTANDING — needs a tablet** |
| **One-branch pilot for a week** | ⬜ **OUTSTANDING — the owner's, and the real gate** |

**Why Phase 10 is 🟨.** Everything provable from a shell and a desktop browser
is proven. The two things §16 actually asks for at the end — a responsive pass
on **real devices** and a **one-week single-branch pilot run alongside paper** —
are hands-on and cannot be closed from here. They join the Phase 4, 6 and 9
device passes.

---

## What Phase 9 built

```
src/server/services/
  backup.ts        §13.1 archive creation (pg_dump -Fc + data tar + manifest),
                   §13.2 retention with the never-delete-to-zero floor (D-73),
                   §13.4's escalation ladder and copy log. offsiteLevelFor /
                   offsiteMessageFor are pure, so the boundaries are cheap to
                   test.
  maintenance.ts   The remaining §11 jobs: session + idempotency-key cleanup
                   (closes D-16), low-stock scan, weekly nag, and
                   syncBackupAlerts (D-75). Alerts go to SystemAlert, which the
                   Phase 3 dashboard already renders.
  audit-log.ts     §4.16's reader. Owner-only, read-only, cursor-paged (D-76).
  settings.ts      TOUCHED: + updateBusinessDayStartHour (D-77).

src/server/jobs/
  scheduler.ts     TOUCHED: all six §11 jobs now registered. `register()`
                   contains errors so one failing job cannot take the
                   scheduler — and therefore the backup — down.

src/app/(app)/settings/backups/
  page.tsx + backup-screen.tsx   §13.4's three controls. The red state has no
                   dismiss path, by design (D-72).

src/app/(app)/settings/audit-log/page.tsx    §4.16 viewer.
src/app/(app)/settings/system/business-day-hour-form.tsx   §8.10 (D-77).

src/app/api/
  backups/route.ts                 GET status/archives/runs · POST take one
  backups/download/route.ts        One-tap export. STREAMED, not buffered.
  backups/offsite-copy/route.ts    The copy log
  audit-log/route.ts               GET only
  settings/business-day-start-hour/route.ts
  health/route.ts                  TOUCHED: + backup freshness (§13.4).
                   Unauthenticated, so it reports timestamps only — never an
                   archive filename.

scripts/
  backup.ts        `npm run backup` — same service the cron calls, not a copy.
  restore.sh       §13.3. Checksum, --force guard, and the manifest row-count
                   DIFF that makes a partial restore fail loudly.
  verify-phase9.sh 76 checks.

Dockerfile         TOUCHED: postgresql-client-16 from PGDG (D-74).
next.config.ts     TOUCHED: three more modules excluded from the edge bundle
                   (D-47's list). `reports` is the one that matters — it
                   reaches argon2 and stops the dev server booting outright.
```

**No migration.** `BackupRun` and `AppSetting` have existed since the Phase 0
schema, so PRD §6 still matches `prisma/schema.prisma`.

**§16 criterion:**

| Criterion | Status |
|---|---|
| A full restore reproduces the system exactly, verified against the manifest | ✅ **mechanically, on this machine.** `verify-phase9.sh` takes a real backup, restores it into a scratch database and compares all 32 tables against the manifest — 1711 sales, 200 customers, 496 attendance rows, 12 photo files, all exact. Three mutations confirm the script goes red, including §13.3's own worked case: a restore quietly missing 90 sales fails loudly and names the shortfall. |
| **…and you have personally rehearsed it once, start to finish** | ⬜ **OUTSTANDING — this one is the owner's.** |

**Why Phase 9 is 🟨 and not ✅.** §16's acceptance has two halves and the second
is explicitly a human act: *"a full restore onto a clean machine … and you have
personally rehearsed it once, start to finish."* Everything provable from a
shell has been proven, but the rehearsal on a **second physical machine** —
which is what proves the archive is portable, the `.env` is reproducible, and
the owner can actually do it under pressure — has not happened. It is also, per
§15's manual checklist, a go-live requirement.

Phases 4 and 6 are waiting on their own device passes. **All three are hands-on
and could be done in one sitting.**

---

## What Phase 8 built

```
prisma/
  demo.ts         §10's --demo / --reset-demo. FIXED SEED (D-61). Refuses any
                  database not named _dev/_test.
  seed.ts         TOUCHED: --demo / --reset-demo flag handling + the guard.

src/server/services/
  reports.ts      THE metrics engine. Every §9 metric. resolveScope() is the
                  single place shop scoping is decided (D-60); assertCanSeeCost
                  is `every`, not `some` (D-62).
  dashboard.ts    §8.3 / §8.4 payloads. TWO return types, not one with optional
                  fields — a manager's payload has no cost keys to strip.
  reports-export.ts  CSV builders, one per report. Role branch must match the
                  service's own (D-63).

src/server/
  csv.ts          RFC 4180 escaping, UTF-8 BOM for Excel, no-store headers.

src/app/(app)/dashboard/
  page.tsx + dashboard-view.tsx    §8.3's five rows including the alerts panel.

src/app/(app)/reports/
  report-shell.tsx   Shared shell, table and totals for every report screen.
  page.tsx           Index; owner-only reports hidden from a manager.
  sales/ attendance/ low-stock/ prize-expense/ stock-valuation/ profit/
  liability/         The six screens (D-66), plus low-stock.

src/app/(app)/reports/report-filters.tsx        D-68's filter bar: presets,
                  custom dates, shop picker. Client component; navigates by URL.
src/app/(app)/dashboard/shop-picker.tsx         D-69. §8.3's All-shops/one-shop
                  selector. Separate from the report filters — no date range.
src/app/(app)/expenses/expense-filters.tsx      D-69. §8.8's range, category and
                  shop filters. Its chips are NOT the add form's chips.
src/app/(app)/expenses/edit-expense.tsx         D-70. Owner-only edit + soft
                  delete. THE reference shape for a reason dialog — Phase 10's
                  window.prompt sweep should copy this, not invent one.

src/server/auth/page-guard.ts   TOUCHED: asPageError now maps NOT_FOUND too
                  (D-68), not only FORBIDDEN.

src/server/services/__tests__/reports.test.ts   36 tests.
scripts/verify-phase8.sh                        65 HTTP-level checks.
```

APIs: `/api/dashboard`, `/api/reports/[name]`, `/api/reports/[name]/export`.

`/api/reports/tickets-awarded` (Phase 3) is a **static** sibling of the new
dynamic `[name]` segment and takes precedence. Verified by booting the app —
D-33's slug rule is not caught by typecheck or lint.

**No migration.** Phase 8 reads; it adds no columns, so PRD §6 still matches
`prisma/schema.prisma`.

**§16 criterion:**

| Criterion | Status |
|---|---|
| Every metric in §9 matches a hand-calculation against the demo dataset | ✅ `verify-phase8.sh` recomputes revenue, transactions, unique customers, walk-ins, payment split, prize expense, shrinkage, operating expenses, gross and net profit, tickets awarded/redeemed, outstanding marbles and tickets, estimated liability, stock valuation, late count and late rate — all in **independent SQL** that never calls the engine. 93/93 pass. Mutations confirm the script goes red (D-62's fourth is the one that mattered). |

Also verified: a plain manager sees no cost value or cost column on **any**
report or export; staff are refused on all sixteen endpoint/export combinations;
a Purchasing manager reads cost at their own shop but is still 403 on profit and
on the owner customer report; both branches of the `shopId` parameter (D-34's
lesson); and the manager dashboard has **no cost keys at all**, checked in the
rendered HTML as well as the JSON.

---

## What Phase 7 built

```
src/server/services/
  expenses.ts     Categories (the §16 delete-if-unused rule) + expense CRUD,
                  role scoping in SQL, soft delete, the D-55 amount guard.
  receipts.ts     Receipt storage. Same shape as attendance-photo, NO
                  watermark (D-57). Re-encodes to strip EXIF/GPS.

src/server/auth/
  context.ts      TOUCHED: + expenseShops() — like selectableShops but
                  INCLUDING HQ (D-54).

src/app/(app)/expenses/
  page.tsx + expense-screen.tsx    §8.8 list, running total, add form.

src/app/(app)/settings/expense-categories/
  page.tsx + category-manager.tsx  Owner-only. Where the 409 refusal is seen.

src/server/services/__tests__/expenses.test.ts   15 tests.
scripts/verify-phase7.sh                         44 HTTP-level checks.
```

APIs: `/api/expense-categories`, `/api/expense-categories/[id]`,
`/api/expenses`, `/api/expenses/[id]`, `/api/expenses/[id]/receipt`.

**No migration.** `Expense` and `ExpenseCategory` have existed since the Phase 0
schema, so PRD §6 still matches `prisma/schema.prisma`.

**§16 criterion:**

| Criterion | Status |
|---|---|
| Deleting a used category returns a clear refusal with the usage count | ✅ 409 `CATEGORY_IN_USE`, count in `error.details.usageCount` **and** in the message; proven at service level, at HTTP level, and **rendered in the browser** — *"Electricity" is used by 1 expense and cannot be deleted. Archive it instead…* Three mutations confirm the check goes red (D-59). |

Also verified: HQ accepts expenses while a transfer to HQ is still refused;
`businessDate` ignores a client-sent value; money survives as a string at
`1234567890.12`; a replayed Idempotency-Key creates exactly one row; the full
§3.4 permission matrix including the unscoped-manager branch (D-34's lesson);
and a delete is soft, audited and carries its reason.

**Unlike Phases 4 and 6, Phase 7 has no device-level criterion.** §16 asks for
one thing and it is fully provable from a shell and a browser, which is why this
row is ✅ rather than 🟨.

---

## What Phase 6 built

```
src/lib/
  lateness.ts             computeLateness + clockInDayOffsetFor. Pure, no DB,
                          so §15's boundary cases are cheap to test (D-46).

src/server/services/
  attendance.ts           Clock-in / clock-out / status / list / edit, the
                          read rule, and the one-record-per-day guard.
  attendance-photo.ts     Server-side watermarking, the EXIF check (D-44),
                          storage under data/attendance/YYYY/MM/DD.
  shifts.ts               §4.14 CRUD. Editing never rewrites past lateness.
  photo-retention.ts      The 61-day purge (D-49).

src/components/
  attendance-banner.tsx   The §4.13 red banner. Not dismissible (D-45).
  ui/button.tsx           TOUCHED, not created: nativeButton is now derived
                          from `render` (D-53). Affects every phase's buttons.

src/app/(app)/attendance/
  clock-in/               Shift → camera → location → upload (§8.9).
  page.tsx + attendance-list.tsx   History, team toggle, owner Excuse.

scripts/verify-phase6.sh          41 HTTP-level acceptance checks.
scripts/lib/check-watermark.mjs   Pixel-level watermark assertion (D-48).
```

APIs: `/api/attendance/status`, `/api/attendance/clock-in`,
`/api/attendance/clock-out`, `/api/attendance`, `/api/attendance/[id]`,
`/api/attendance/[id]/photo`, `/api/shops/[id]/shifts`,
`/api/shops/[id]/shifts/[shiftId]`.

**No migration.** `Attendance` and `Shift` have existed since the Phase 0
schema, so PRD §6 still matches `prisma/schema.prisma`.

**§16 criteria:**

| Criterion | Status |
|---|---|
| Lateness is correct at the grace boundary | ✅ 12 unit tests, both sides of 5:00/5:01 and of a midnight crossing; three mutations caught |
| The banner behaves exactly as specified | ✅ on dev — `required` is false for OWNER and true for the others, it clears on clock-in, and it has no dismiss path |
| The watermark is legible | ✅ verified by rendering it and by a pixel-level check; both the coordinates and the `LOCATION UNAVAILABLE` variant |
| A clock-in works with location granted **and** denied | 🟨 both paths proven over HTTP **and** through the real client in a browser (D-51), but **on a dev machine only** |

**The on-device pass is the outstanding gate.** §16 asks for a clock-in on a
real tablet with location granted and denied; §15's manual checklist asks for
the same. The camera (`getUserMedia`) and the geolocation prompt cannot be
exercised from a shell, so Phase 6 is complete on dev and **not signed off**.

**A browser pass on 7 Aug 2026 narrowed that gap without closing it** — it drove
the real client through both location paths and caught one genuine §8.11
violation (D-52) plus a codebase-wide a11y warning (D-53). It is still not the
device gate: the camera was OBS Virtual Camera and geolocation was stubbed.
Read **D-51** before treating any of it as sign-off.

---

## What Phase 5 built

```
src/server/services/
  transfers.ts    Dispatch / receive / cancel with batch provenance, the
                  in-transit figure, and the §4.10 both-ends permission rule.
                  batchPlan on PrizeTransferLine is the record of which source
                  batches were consumed; receive replays it.
  opname.ts       Counting sessions, the anti-anchoring guarantee (D-41), and
                  variance commit — OPNAME_LOSS via consumeFifo for shrinkage,
                  an isAdjustment batch at weightedAverageCost for found stock.

src/server/services/__tests__/
  transfers.test.ts  13 tests, including §15's dispatch→receive conservation.
  opname.test.ts      9 tests, including §15.8 and §15.9 at route level (D-29).

scripts/verify-phase5.sh   42 HTTP-level acceptance checks.
```

APIs: `/api/transfers`, `/api/transfers/[id]/receive`,
`/api/transfers/[id]/cancel`, `/api/opname`, `/api/opname/[id]`,
`/api/opname/[id]/lines`, `/api/opname/[id]/commit`.

Screens: the **Transfers** and **Opname** tabs on `/stock`, completing §8.7's
five (D-35 deferred them from Phase 4 rather than stubbing them).

**No migration.** `PrizeTransfer`, `PrizeTransferLine`, `OpnameSession` and
`OpnameLine` have existed since the Phase 0 schema, so PRD §6 still matches
`prisma/schema.prisma` and needed no reconciliation.

**§16 criteria proven:**

| Criterion | How |
|---|---|
| A transfer round trip conserves quantity **and** total cost | `verify-phase5.sh` sums quantity and `qty × unitCogs` across BOTH branches before and after, and asserts the destination holds one batch per source batch at the original costs (`6@1000,2@3000`), not one averaged batch. Also proven in `transfers.test.ts`. |
| An opname loss is shrinkage, not prize expense | The committed movement is asserted to be `OPNAME_LOSS`, never `REDEEM` — at service level and against the database over HTTP. |

Both are proven **on a dev machine**. Like Phase 4, the device-level half of
§15's manual checklist — a real manager doing a real count on the actual
tablet — has not happened.

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

> **Run all ten in numeric order, not just the phase you touched (D-100).**
> The full sequence is the go-live gate. As of 9 Aug 2026 it is **469 ✓, 0 ✗,
> 3 skips**, stable over three consecutive runs. Two caveats that will otherwise
> look like regressions:
>
> - After `verify-phase1.sh` the owner's password is `OwnerRealPass2026!`, so
>   export `OWNER_PASSWORD='OwnerRealPass2026!'` before phases 8–10.
> - A database reset destroys `p8mgr` / `p8purch` / `p8staff` (D-94). Recreate
>   them via `POST /api/users` **and** complete each forced password change
>   (that is what appends the trailing `x`) before phases 8 and 10.

```bash
npm run typecheck                 # clean
npm run lint                      # clean
npm test                          # 236 tests (D-26, D-91) — safe to re-run, no residue
docker compose build              # succeeds (catches Linux case-sensitivity)
bash scripts/verify-phase1.sh     # 21/21 acceptance checks, needs npm run dev
bash scripts/verify-phase2.sh     # 30/30 acceptance checks, needs npm run dev
bash scripts/verify-phase3.sh     # Phase 3 PASS, needs npm run dev
bash scripts/verify-phase4.sh     # 35 checks, needs npm run dev
bash scripts/verify-phase5.sh     # 42 checks, needs npm run dev
bash scripts/verify-phase6.sh     # 41 checks, needs npm run dev
bash scripts/verify-phase7.sh     # 44 checks, needs npm run dev
bash scripts/verify-phase8.sh     # 93 checks, needs npm run dev AND --demo data
bash scripts/verify-phase9.sh     # 76 checks, needs npm run dev
bash scripts/verify-phase10.sh    # 57 checks, needs npm run dev AND --demo data
```

**`verify-phase10.sh` reads only** — it creates no rows and is safe to re-run.
It needs the demo dataset for the reports to have anything in them, and it sets
a work session for each test account first: without one, §4.7 redirects every
page to `/select-shop` and every check reports 307, which looks exactly like a
permission bug.

`npm test` was **193 tests** at the end of Phase 10 (was 180): +3 for the
clock-out card's service fields (D-81) and +10 for the two new report services
(D-82, D-84). It is **236** as of 9 Aug 2026, after D-91 added the business-date
and phone suites.

**`verify-phase9.sh` writes.** It creates real archives under `backups/`, and
creates and drops a scratch database called `marblehouse_verify9`. It never
touches `marblehouse_dev`'s data, and it restores the copy log to "now" before
finishing. It needs `pg_dump`, `pg_restore`, `psql` and `createdb` on PATH —
Homebrew Postgres 16 provides all four on this Mac.

**`verify-phase8.sh` needs the demo dataset** (`npm run db:seed -- --demo`) and
the Phase 8 test accounts. It reads only — it creates no rows of its own — so it
is safe to re-run. It takes the account passwords from `OWNER_PASSWORD`,
`MGR_PASSWORD`, `PURCH_PASSWORD` and `STAFF_PASSWORD` if set, and otherwise
falls back to the values recorded under *Current database state*.

**`verify-phase5.sh` and `verify-phase6.sh` were last run green on 7 Aug 2026**,
at the end of Phase 6, together with typecheck, lint, all 116 tests and
`docker compose build`. `verify-phase{1,2,3,4}.sh` were last run green earlier
the same day and have not been re-run since; they write test data, so re-run
them in numeric order against a scratch database if you need them.

`docker compose build` needs the Docker Desktop daemon actually running, not
merely installed — `open -a Docker` first.

**Phase 6 note:** `npm run dev` must be running for `verify-phase6.sh`, and the
suite writes watermarked JPEGs under `data/attendance/`. Those are gitignored
and are not cleaned up by the script — `npm test` cleans up its own.

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

## Post-phase gap work — 18 Aug 2026 · Settings → Shops

**Shop administration, which no phase ever built.** §5.6 and §8.10 both specify
it; Phase 10 closed without it and it was not recorded as a debt. Adding a
branch meant `db:studio` or editing the seed.

### What was built

| File | What it is |
|---|---|
| `src/server/services/shops.ts` | **New.** `listShops`, `getShop`, `createShop`, `updateShop`, the Zod schemas and `toShopDTO`. OWNER-gated in the service, not only at the route. |
| `src/app/api/shops/route.ts` | **New.** `GET` (list) and `POST` (create). The collection endpoint did not exist — only `[id]/presets`, `[id]/shifts`, `[id]/prizes` did. |
| `src/app/api/shops/[id]/route.ts` | **New.** `GET` and `PATCH`. `[id]` not `[shopId]`, matching its siblings (D-33). |
| `src/app/(app)/settings/shops/page.tsx` | **New.** Owner-only page guard. |
| `src/app/(app)/settings/shops/shop-admin.tsx` | **New.** List, create form, deactivate/reopen, and the empty-branch warning. |
| `src/app/(app)/settings/page.tsx` | Adds the **Shops** row, owner-only. |
| `src/server/services/__tests__/shops.test.ts` | **New.** 16 tests. |
| `scripts/verify-shops.sh` | **New.** 30 HTTP checks across all three roles. Re-runnable. |

`src/app/(app)/sale/page.tsx:50` already pointed the owner at "Settings →
Shops". That reference now resolves to a real screen; it was dangling.

**No migration.** The `Shop` model already had every column this needed — the
data model was never the gap, only the UI and service on top of it.

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **252 tests**, 16 files, green (236 before this change).
- **Six mutation checks**, each confirmed to turn the suite red and then
  reverted: the owner gate on create, the last-active-branch guard, the HQ
  guard, reintroducing the §5.6 clone step, dropping the code's
  `.toUpperCase()`, and making `code` mutable. Two of them exposed real bugs —
  see D-102.
- `scripts/verify-shops.sh` — **30/30**, run three times, plus a mutation check
  (weakening the page guard to manager-or-owner turns it red).
- **`docker compose build` was NOT run — the Docker daemon is not running on
  this machine.** CLAUDE.md item 4 asks for it to catch case-sensitive import
  bugs macOS hides. As a partial substitute every `@/` import in the new files
  was resolved case-exactly against the filesystem, and all eight are fine. The
  Docker build should still be run before this ships.

### D-101 · Settings → Shops: a new branch starts EMPTY, with no clone step

**Added 18 Aug 2026.** Shop administration was specified in §5.6 and §8.10 and
never built — the PRD's "self-service branch creation" was a gap, not a
deferral, and it was not in this list either. The only way to add a branch was
`db:studio` or editing the seed. `src/app/(app)/sale/page.tsx` even told the
owner to go to "Settings → Shops", a screen that did not exist.

**§5.6 specifies a clone step and this deliberately does not implement it.**
The spec says the new-shop flow "clones sale presets and shifts from an
existing shop as a starting point". The owner chose the simple flow instead:
**always start empty.**

The reasoning, because a later session will otherwise "restore" the clone:
cloning copies *money amounts* and *opening hours* from one branch to another.
A preset that is silently wrong is worse than one that is visibly absent —
staff would sell at the old branch's prices and nobody would have chosen that.
Presets and shifts each already have their own screen, so the re-entry §5.6
worried about is a few minutes, once, at a moment the owner is already
concentrating on a new branch.

**The cost is real and is paid in the UI, not hidden.** A shop with no preset
cannot take a sale (`createSale` requires a preset or `allowCustomAmount`). So:

- the create form states, before submission, that the shop starts empty and
  names the three follow-up steps (presets, shifts, staff);
- the success toast repeats it;
- the shop list shows a **red warning** against any active branch with zero
  presets and no custom amounts — "this branch cannot take a sale until you add
  one". That warning is what makes starting empty safe to ship, and it should
  not be softened into a muted hint.

**Other decisions taken in the same change:**

| Decision | Why |
|---|---|
| `code` is **immutable** after creation | Same call as `User.username` (D-3). The code identifies a branch on exported CSVs, in the audit log and in conversation; those references are already filed. `name` is the mutable label. It is absent from `updateShopSchema`, so sending it is a silent no-op — tested. |
| `code` is **uppercased** by the schema | The column is `@unique`, but Postgres uniqueness is case-SENSITIVE. Without this, `br-2` and `BR-2` would both be accepted and every human reading a report would treat them as one branch. |
| `isHqPseudoShop` is **not settable** | There is exactly one HQ (§4.12). Minting a second — or flipping a trading branch into one — would quietly remove it from every sale picker and dashboard. Absent from both schemas; create hardcodes `false`. |
| **No day-start hour on the form** | §5.6 lists one; §5.6 predates D-18. The cutoff is global and lives in Settings → System. |
| **No delete, only deactivate** | A shop owns sales, ledger rows, batches and attendance — CLAUDE.md's soft-delete rule covers all of it. |
| **The last active branch cannot be retired** | Otherwise the owner reaches a state where the day-start picker is empty, nobody can declare a work session, and nothing can be recorded — recoverable only from the database. |
| **HQ cannot be deactivated** | `expenseShops` filters on `isActive`, so closing HQ would remove the only place head-office expenses can be booked, with no obvious cause. |
| Timezone validated against the **runtime tz database** | Via `Intl.DateTimeFormat`, not a hand-kept list. A typo misfiles every business date at that branch and would surface months later as a reporting bug. |

Settings → **Shops** (plural, owner-only, branch administration) is a different
screen from Settings → **Shop** (singular, every role, today's work-session
picker). Both exist; the names are one letter apart and the index lists them
separately.

### D-102 · Two verification bugs the mutation checks exposed

Both were found by deliberately breaking things per CLAUDE.md item 3, and
neither would have been visible in a passing run.

**1. A destructive test left the seed database broken.** The "HQ cannot be
deactivated" and "last active branch" tests ask the service to close real seed
rows and assert it refuses. When the mutation check *removed* those guards to
confirm the tests go red, the calls succeeded — and HQ and BR-1 stayed
deactivated after the run. Every later test run then failed for an unrelated
reason, which reads as a new bug. Both tests now restore state in a `finally`,
including the row they expected to survive.

**2. `verify-shops.sh` reported permission passes it had not tested.**
`manager1` and `staff1` do not survive a reseed (D-94), so the logins failed
silently and every "a manager is refused" check saw **401** where it wanted
403 — and three of them were checking a page redirect that returns 307 for an
anonymous user. The script now creates the fixtures if missing (as
`verify-phase4.sh` does for `purchaser1`) and **asserts each session is usable
before running a single permission check**, aborting outright if not. A 403
proves nothing when the alternative is that nobody was logged in.

While there: `scripts/verify-phase4.sh:11` still `cd`s to
`/Users/ricky/redlight`, the project's former name — the same defect D-99 fixed
in `verify-phase1.sh`. Not fixed here (out of scope), recorded below.


### D-103 · Sale prices: the screen D-101 assumed existed

**Added 18 Aug 2026, immediately after D-101 — reported by the owner.** They
created a branch, were told "No sale presets yet — this branch cannot take a
sale until you add one", and **could not find anywhere to add one.**

They were right: there was nowhere. `GET /api/shops/:id/presets` existed for
the sale screen, but §7.2's `POST/PATCH/DELETE` were never built and no UI ever
existed. D-101's warning pointed at a dead end, and D-101 shipped a create flow
whose stated next step was impossible. The debt list said "worth building
before the second branch opens"; the second branch was opened the same day.

**Lesson worth keeping:** an empty-start decision is only as good as the screen
that fills the emptiness. If a flow ends by telling the owner to go somewhere,
that somewhere is part of the same change, not a follow-up.

### What was built

| File | What it is |
|---|---|
| `src/server/services/shops.ts` | Extended: `listPresetsForAdmin`, `createPreset`, `updatePreset`, `deletePreset`, `addDefaultPresets`, and their schemas. |
| `src/app/api/shops/[id]/presets/route.ts` | Gains `POST`. `GET` now serves two audiences — see below. |
| `src/app/api/shops/[id]/presets/[presetId]/route.ts` | **New.** `PATCH` and `DELETE`. |
| `src/app/(app)/settings/shops/[id]/presets/{page,preset-admin}.tsx` | **New.** The owner's price manager. |
| `src/app/(app)/settings/shops/shop-admin.tsx` | The warning is now a **link** to this screen, and every branch row gets a "Prices" button with its count. |

### Decisions

| Decision | Why |
|---|---|
| **`?admin=1` splits one URL between two audiences** | Default `GET` is the SALE SCREEN's list — active only, no use counts, readable by anyone with shop access. Staff must keep reading it or they cannot ring up a sale. `?admin=1` is the owner's list: active *and* retired, each with its sales count, OWNER-only. Two guards, one route, because they are genuinely the same resource seen at two permission levels. |
| **§4.3's supersede rule is implemented, not approximated** | A `Sale` stores `presetId`, not a copy of the amount. Editing 50.000 → 60.000 in place would silently restate every historical sale pointing at it — last month's revenue would change with nothing explaining why. So: amount changed **and** the preset has sales → the old row is deactivated and a **new** preset created, in one transaction. The response carries `supersededId` and the UI warns *before* saving, because an unexplained extra row reads as a duplicate-creation bug. |
| Amount edits **in place** when the preset was never sold | Nothing points at it, so there is no history to protect. Fixing a typo should not litter the list with retired rows. |
| **Delete only when unused** | §13.5 explicitly permits a hard delete for an unused sale preset, which is why this is a real delete. Once a sale references it, `DELETE` is a 409 naming the count and pointing at retiring instead — and the UI does not offer the button at all. |
| **A "use the standard prices" button, not §5.6's clone** | An empty branch offers the five documented defaults (20/50/100/200/500k) in one tap. This is **not** the clone step D-101 rejected: cloning copies another branch's real, possibly-tuned prices with no indication of their origin; this inserts the *documented defaults*, on an explicit tap, only when the shop has none, with every one editable straight after. Refuses with 409 if any price already exists, so a second tap cannot duplicate. |
| Duplicate **active** amounts refused per shop | Two buttons at the same price on one till is a mis-tap waiting to happen. Scoped per shop — the same amount at a different branch is fine and is tested. |
| Whole rupiah only, as a **string** | `^\d+$`, parsed to `Decimal`. A JSON number would already have been through a double (D-13). |
| New prices append to the end | A new price must not silently jump to the front of the till. |

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **267 tests** (was 252). 15 new, covering the supersede rule from
  both sides, the delete refusal with its count, cross-shop scoping, and the
  OWNER gate on all five operations.
- **Four mutation checks**, each confirmed red then reverted: turning supersede
  into an in-place edit (the money bug), allowing a used preset to be deleted,
  dropping the cross-shop ownership check, and removing the owner gate.
- `scripts/verify-shops.sh` — extended to **53 checks**, all green, run twice.
  Section 10 records a real sale against a preset and then asserts the old row
  keeps `20000` and the historical sale is untouched after a re-price.
- Rendered end to end as the owner: empty branch → warning link → defaults →
  five prices live on the sale screen's own endpoint.
- **`docker compose build` still not run** — the Docker daemon is not running on
  this machine (same as D-101). Imports were checked case-exactly instead.

### D-104 · A greedy `sed` made a verification check lie

`verify-shops.sh` extracted a preset id with `sed 's/.*"id":"\([^"]*\)".*/\1/p'`.
The JSON body is a **single line** and `.*` is greedy, so it returned the
**last** id in the list, not the first — the script recorded a sale against the
500.000 preset and then asserted the old amount was 20.000. It reported a
failure that did not exist.

Now `first_id()`, a `grep -o | head -1`, and no greedy form remains in the file.
Worth knowing because two other call sites used the same pattern and were
correct only by accident — they happened to parse single-object responses.


### D-105 · Shifts: the other half of the empty branch

**Added 18 Aug 2026.** The twin of D-103, and the last of D-101's three
follow-up steps. `POST/PATCH/DELETE /api/shops/:id/shifts` and
`src/server/services/shifts.ts` have existed since **Phase 6** — complete,
correct, and unreachable. No screen ever called them.

**Why this one mattered more quietly than prices.** No prices *blocks* selling,
so it announces itself. No shifts does not block anything: `clockIn` only
computes lateness when a shift is matched (`attendance.ts` — `isLate` stays
`false` with no shift), so a branch with none records **every arrival as
punctual**. The owner sets a 5-minute grace, sees perfect attendance, and has
no reason to suspect the control was never running.

### What was built

| File | What it is |
|---|---|
| `src/app/(app)/settings/shops/[id]/shifts/{page,shift-admin}.tsx` | **New.** The shift manager. |
| `src/app/(app)/settings/shops/shop-admin.tsx` | A **Shifts** button per branch with its count, plus a second warning row. |
| `src/server/services/__tests__/shifts.test.ts` | **New.** 14 tests — `shifts.ts` had none since Phase 6. |
| `scripts/verify-shops.sh` | Section 11: 19 more checks. **72 total.** |

No service or API changes. Phase 6 built those correctly, including the
crosses-midnight case and the no-recompute rule; this is purely the missing UI.

### Decisions

| Decision | Why |
|---|---|
| **MANAGER *or* owner, not owner-only** | Unlike Settings → Shops itself and the price screen. §3.4 delegates shift configuration, and `assertCanManageShifts` already implemented exactly that. The page mirrors the service rather than inventing a stricter rule — a manager held to a lateness rule should be able to see the shift it is measured from. They remain confined to their own branches (tested from both sides). |
| **STAFF are refused the page outright** | See D-106 — this was wrong on the first attempt. |
| A **"use the standard shifts" button** | Morning 10:00–18:00 and Evening 18:00–23:00, the seed's own defaults, on an empty branch. Same reasoning as D-103's price defaults, and equally not a clone of another branch. There is no bulk endpoint, so it POSTs each in turn and **stops at the first failure** rather than reporting a partial result as success. |
| The **empty state names the consequence** | "Staff can still clock in, but with no shift to measure against **nobody is ever recorded as late**." The silent-disable above is the whole risk; a neutral "no shifts yet" would hide it. |
| The **crosses-midnight case is labelled, not corrected** | A 22:00–06:00 night shift is legitimate (§4.14). The DTO already exposed `crossesMidnight`; the row and the form both say "runs past midnight" so it does not read as a data error. A mutation test pins this — the tempting "fix" of rejecting `end <= start` is exactly what must not happen. |
| The edit form **says editing is safe** | §4.14 snapshots the shift start on each attendance row, so a correction never restamps history. Saying so matters: fear of retroactively marking staff late is precisely what stops someone fixing a wrong time. |
| Removal wording follows what the server **actually did** | `deleteShift` returns `{deactivated, deleted}` — a shift with attendance is retired so historical rows keep resolving their name; one with none is deleted. The toast reports whichever happened rather than guessing. |

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **281 tests / 17 files** (was 267 / 16).
- **Five mutation checks**, each red then reverted: always hard-deleting a used
  shift, dropping the STAFF refusal, dropping the manager's shop confinement,
  rejecting cross-midnight shifts, and restamping past attendance on edit. The
  last is the one that silently rewrites history.
- `scripts/verify-shops.sh` — **72 checks**, green twice, and the STAFF check
  confirmed to go red when the page guard is weakened.
- **`docker compose build` still not run** — the Docker daemon is not running on
  this machine (as in D-101 and D-103). This change adds two `.tsx` files whose
  imports were checked case-exactly; the build should still be run before ship.

### D-106 · The shifts page rendered for STAFF with the buttons hidden

Caught by `verify-shops.sh` section 11 on its first run: **200 where 403 was
expected.**

The first version guarded the page with `requireActorPage()` and passed a
`canManage={actor.role !== "STAFF"}` flag down to hide the controls. The
reasoning was that `shifts.ts` refuses STAFF every mutation anyway — which is
true, and beside the point. A staff account could open a configuration screen
and read the branch's full shift setup, including retired shifts, because
`listShifts` deliberately permits a staff READ (the clock-in chooser needs it).

CLAUDE.md rule 4 and §3.4 both say it plainly: **hiding a button is not a
permission.** The page now uses `requireManagerOrOwnerPage()` and the
`canManage` prop is gone entirely rather than left as a dead constant.

Two things worth carrying forward:

1. **A service that allows a read and refuses the writes does not settle who
   may see the SCREEN.** Those are three separate questions, and the page has
   to answer the third itself.
2. This is the second time in this run of work that a permission bug was
   invisible to `typecheck`, `lint` and the unit suite, and visible immediately
   in a rendered page as a role (D-34's lesson, again). The `verify-shops.sh`
   page-load checks earn their keep.


### D-107 · Staff assignment from the shop — and `PATCH /api/users/:id` had no caller

**Added 18 Aug 2026.** The last of D-101's three follow-up steps, and it turned
out to be more than the wayfinding gap the debt list described.

`/settings/users` is **create-only**. `PATCH /api/users/:id` and `updateUser`
exist, are owner-gated and are tested — and **nothing in the UI has ever called
them.** So shop access could be set when an account was created and never
changed again. Same shape as D-103 and D-105: a complete, correct service
reachable only by curl.

### What was built

| File | What it is |
|---|---|
| `src/server/services/users.ts` | Extended: `listShopStaff`, `setShopAssignment`. |
| `src/app/api/shops/[id]/staff/route.ts` | **New.** `GET` and `PATCH`, OWNER only. |
| `src/app/(app)/settings/shops/[id]/staff/{page,staff-admin}.tsx` | **New.** |
| `src/server/services/shops.ts` | `toShopDTO` gains `staffCount`. |
| `src/app/(app)/settings/shops/shop-admin.tsx` | A **Staff** button per branch, and a third warning row. |

### Decisions

| Decision | Why |
|---|---|
| **One (user, shop) pair per request**, not a whole-array replace | `updateUser` replaces a user's ENTIRE `shopIds` array. Driving that from a shop screen means read-modify-write, so a stale checkbox could revoke a branch nobody was looking at. `setShopAssignment` touches exactly one pair; a test asserts the user's other branches survive. |
| **OWNER-only**, unlike the shifts screen | §3.4 puts "set shop access" in the owner column alone. Shifts are delegated to managers; this is not. |
| **Nobody can be left with zero shops** | A MANAGER or STAFF with no assignment logs in to an empty picker and can do nothing. `updateUser` already refused it; this refuses it per-pair, and the DTO carries `isOnlyShop` so the UI explains it *before* the tap rather than via a failed toast. |
| **The default shop follows an unassignment** | `defaultShopId` drives the actor's timezone in `actorBusinessDate`. Left pointing at a branch the user no longer works at, it silently misfiles their business date. It moves to a remaining shop, or null. |
| **Sessions are revoked on removal** | Same reasoning as R-9's deactivation rule: their live work session may point at a shop they no longer have, and `hasShopAccess` reads from the session-loaded actor. Up to 12 hours of retained access is not acceptable for a revocation. |
| **OWNERs are neither listed nor assignable** | They reach every shop without an assignment (§3.1). A `UserShop` row for an owner is a no-op that later reads as meaningful. Assigning one is a 422. |
| **Deactivated accounts are not offered** for a new assignment | But they still appear under "works here" if they already had the shop, so nobody silently vanishes from a branch's list. |
| Account creation **stays in Settings → Users** | This screen links there rather than duplicating the form, so usernames and temporary passwords keep one path. |
| The empty state is **destructive-red** | With nobody assigned the branch is absent from every non-owner shop picker — nothing can be recorded there at all. A harder block than a missing price. |

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **292 tests / 17 files** (was 281). 11 new.
- **Four mutation checks**, each red then reverted: allowing someone to be
  stranded with zero shops, turning the per-pair delete into a whole-array
  wipe, not moving the default shop, and not revoking sessions.
- `scripts/verify-shops.sh` — **89 checks**, green twice, and the strand guard
  confirmed to go red when broken.
- **`docker compose build` still not run** — the Docker daemon is not running
  on this machine (as in D-101, D-103 and D-105).

### D-108 · Escaped JSON inside `chk "$( )"` silently sent no body at all

The nastiest of the three verification bugs in this run of work, because it
reported **green while testing nothing.**

Section 12 was written as:

```bash
chk "assigning them to a second branch is 200" \
  "$(c -b $O -X PATCH $B/api/shops/$ASHOP/staff -H 'Content-Type: application/json' \
     -d "{\"userId\":\"$STAFF_ID\",\"assigned\":true}")" 200
```

The inner `\"` survives one level of quoting but not two: nested inside
`chk "…"`, curl received literal backslash-quotes and the server answered
**422 "Expected a JSON body"**. Two later checks then read **0 rows** — which is
what exposed it. Without those row-count assertions the section would have
reported all-green having performed no assignment whatsoever.

Three things worth carrying forward:

1. **Bodies with shell variables go in a file** — `printf … > body.json` then
   `-d @body.json`. Section 12 now does this throughout. Section 4's
   `-d "{\"code\":…}"` is fine because it sits at the top level of `$( )`,
   not nested inside another quoted string — verified rather than assumed.
2. **Assert the effect, not only the status.** A status check alone is
   satisfied by a request that did nothing. Every mutation in section 12 is now
   followed by a row count.
3. **Prove the plumbing first.** The section opens with a probe asserting a
   well-formed body comes back with real data, and aborts the reasoning if not.
   The first version of that probe only grepped for the error string — so it
   passed while curl was failing outright with an unknown-option error. It now
   greps for the expected *success* content instead. Checking for the absence
   of one known failure is not the same as checking for success.


### D-109 · Settings → Users can finally change an account

**Added 18 Aug 2026.** `/settings/users` could create accounts and nothing
else. `updateUser` and `resetUserPassword` shipped in Phase 1, owner-gated and
correct, with **no UI caller and no unit tests** — the fourth instance of that
pattern in one day (D-103, D-105, D-107).

The practical consequence: **a departing staff member could not be
deactivated.** Their login kept working, and the only remedy was `db:studio`.

### What was built

| File | What it is |
|---|---|
| `src/app/(app)/settings/users/user-admin.tsx` | Each row now expands into an edit form and a password panel. |
| `src/app/(app)/settings/users/page.tsx` | Passes **every** shop and the current user's id. |
| `src/server/services/__tests__/users.test.ts` | **New.** 19 tests — `updateUser` and `resetUserPassword` had none. |
| `scripts/verify-users.sh` | **New.** 40 HTTP checks. Separate from `verify-shops.sh` because it touches accounts, not branches. |

Now editable: name, phone, role, shop assignments, Purchasing, active/inactive
with a reason, and a password reset. `username` stays immutable (D-3).

### Decisions

| Decision | Why |
|---|---|
| The page passes **every shop**, not `selectableShops` | `selectableShops` filters to active, non-HQ branches. A user may already be assigned to HQ (§4.12) or to a since-deactivated branch. `updateUser` REPLACES the whole `shopIds` array, so a checkbox that cannot render is an assignment that gets silently stripped on save. Held-but-inactive shops are shown and marked; inactive shops are not offered for a new assignment, since `assertShopsExist` requires `isActive`. A test pins the wholesale-replace behaviour so the reason stays visible. |
| Self-edit controls are **disabled in the form** | You cannot deactivate yourself or change your own role. The server refuses either way; the form greys the control and says why, rather than teaching by red toast. |
| The last-owner guard is **left to the server** | Unlike the self guard it depends on a live count, so the UI cannot know it in advance without a second query that could still be stale. |
| Panels are **collapsed by default** | This list is mostly read. A page of expanded forms is unusable on a phone. |
| The reset panel repeats the **three consequences** | The password is shown once, in person; a change is forced at next login; every session dies immediately. All three surprise people. |

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **311 tests / 18 files** (was 292 / 17).
- **Five mutation checks**, each red then reverted: the self guard, the
  last-owner guard, stripping `canEnterCost` on demotion, the zero-shop guard,
  and the session revoke.
- `scripts/verify-users.sh` — **40 checks**, green twice, plus the self-guard
  check confirmed to go red (see D-111 — it did not, at first).
- `scripts/verify-shops.sh` — still 89 green, no regression.
- **`docker compose build` still not run** — the Docker daemon is not running.

### D-110 · Two username validators disagreed, and the loser was a 500

Found while writing `verify-users.sh`: creating `zzv-test1` returned
**INTERNAL — "Something went wrong"**. Creating `zzvtest2` worked.

Our Zod schema has always allowed dashes (`/^[a-z0-9._-]+$/`). Better Auth's
username plugin was running its **default** validator, which does not. So a
username like `budi-kasir` passed our validation, reached the library, and was
rejected there — and `createUser` maps any `APIError` to `INTERNAL`, so the
owner saw a server error with no field message and no way to guess the cause.

Two fixes, because either alone leaves the trap:

1. `usernameValidator` is now passed to the plugin explicitly, with the **same
   regex as the service**. A comment on each says to change both together.
2. The `APIError` branch of `createUser` no longer reports `INTERNAL`. It
   returns `VALIDATION_FAILED` naming the username field, and logs the
   library's real message to the server console. A library rejection of user
   input is a validation problem, not a server fault.

This was never reachable from the UI before today, because nothing could edit
users — but it has been latent since Phase 1 and would have hit the owner the
first time they created an account with a dash in the name.

### D-111 · A guard test that passed with the guard deleted

The self-lockout check in `verify-users.sh` was:

```
chk "deactivating yourself is 422" ... 422
```

It passed. It also passed **with `if (existing.id === actor.userId)` replaced
by `if (false)`** — because the dev database has exactly one owner, so the
*last-active-owner* guard answered first. The check was real, but it was
proving a different guard than its label claimed, and the self guard could have
been deleted at any point with every test still green.

Fixed by making the two distinguishable: the section now creates a **second
owner** first, so the last-owner guard cannot fire, and asserts the refusal
message contains "your own account" rather than merely being a 422. With the
guard removed the section now goes fully red — the owner deactivates themselves
and is signed out mid-run, which is exactly the failure being prevented.

**The general lesson, and the third variant of it today** (see D-102, D-108):
when two guards can produce the same status code, a status check does not tell
you which one fired. Either assert the message, or arrange the fixture so only
one guard can apply. This one is the most dangerous of the three, because
unlike a mangled request body it leaves no trace at all — the check simply
keeps passing after the code it protects is gone.

### D-112 · Shell brace expansion silently emptied a JSON body

A third false-pass mechanism in `verify-users.sh`, distinct from D-108's
escaping bug:

```bash
patch_user() { printf '%s' "$1" > $D/body.json; ... }
chk "..." "$(patch_user '{"role":"MANAGER","canEnterCost":true,...}')" 200
```

The braces were stripped before `printf` ever ran, so the server received
`"role":"MANAGER",...` — invalid JSON. The status check read 200 from a
different, well-formed call and reported green while `canEnterCost` was never
set. Two row-count assertions caught it.

Every body in this script now arrives on **stdin via a quoted heredoc**
(`<<'JSON'`), which performs no expansion of any kind. That is now the house
style for both verify scripts: never build a JSON body in a shell argument.


### D-113 · Clocking in sent STAFF to a 403

**Reported by the owner, 18 Aug 2026.** A staff member finishing a clock-in was
shown **"You do not have access to this page"**.

`src/app/(app)/attendance/clock-in/clock-in-flow.tsx` had **two** buttons — the
"Done" on the success screen and the "Back" on the already-clocked-in screen —
both hardcoded to `/dashboard`. `/dashboard` is `requireManagerOrOwnerPage`, so
for STAFF that is a guaranteed 403 reached by doing exactly the right thing.

`landingPathFor` in `src/server/services/auth.ts` has always had the correct
rule (`OWNER → /dashboard`, everyone else → `/sale`). The clock-in flow simply
did not use it — a second, wrong copy of a rule that already existed in one
place. The page now passes `doneHref={landingPathFor(actor.role)}` into the
client component. No new rule was added.

`app-shell.tsx` was already correct: STAFF has no Dashboard tab. These two
buttons were the only leak.

**The MANAGER half of the report.** A manager *can* open `/dashboard`, so their
symptom has a different cause: `resolveScope` falls back to `defaultShopId`
when there is no work session, and if that default points at a shop they are no
longer assigned to, the dashboard answers "You do not have access to that shop".
`setShopAssignment` (D-107) moves the default on unassignment, so newly-managed
accounts are safe; an account whose assignment was changed **before** D-107
could still hold a stale default. Checked on this database — all four accounts
are consistent, so nothing to repair here. Worth knowing if it recurs.

**Verified:** typecheck, lint, **315 tests / 19 files** (4 new), both verify
scripts green, and the new section 8 confirmed to go red with the bug
reintroduced.

### D-114 · The regression check tested a screen that was not on the page

Writing the guard for D-113 produced a fourth false pass in one day, and a new
mechanism.

The first version asked: *does the staff clock-in page contain
`href="/dashboard"`?* It passed. It also passed with the bug **fully
reintroduced** — because a fresh clock-in page renders the **camera step**,
whose markup contains no navigation button at all. The check was inspecting a
screen where neither the right answer nor the wrong one exists.

The buttons live on the two POST-clock-in screens. The check now creates an
attendance row first so the "already clocked in" branch renders, and — before
judging anything — asserts a string unique to that branch ("Only one clock-in
is recorded per day") is present. It also counts `/sale` links rather than
merely finding one, since the nav tab supplies one for free and would mask a
missing button.

**Four variants of the same failure in one day** (D-102, D-108, D-111, D-114).
The pattern worth naming: *a check that cannot fail is worse than no check.*
Each time, the fix was to assert something that is only true when the feature
works — a row count, an error message, a screen marker — rather than a status
code or the absence of one string.


### D-115 · `Intl` currency formatting is not portable, and it broke hydration

Reported as a React hydration error on the sale screen in Safari:

```
+ Rp20.000     (client)
- Rp 20.000    (server)
```

`formatMoney` was `Intl.NumberFormat(style: "currency")`. **Engines disagree
about what separates the currency symbol from the digits for `id-ID`:** Node
and V8 emit U+00A0 (a non-breaking space), Safari's JavaScriptCore emits
nothing at all. The sale preset tiles are server-rendered and then hydrated, so
the server sent `Rp 20.000`, Safari rendered `Rp20.000`, React compared
the two strings and tore the tree down.

`formatMoney` now writes the separator itself — an explicit U+00A0 constant —
and delegates only *grouping* to `Intl`, because every engine agrees `id-ID`
groups with `.`. It is the currency **spacing** that is unportable, not the
number formatting. Do not restore `style: "currency"`.

Two things this cost, both worth remembering:

- **Chrome could not reproduce it.** Chrome shares V8's ICU with the server and
  agreed with it perfectly. A browser check that only covers Chrome cannot see
  this class of bug at all; the report came from Safari.
- **The error text sends you to the wrong place.** It names date formatting and
  browser extensions, so the first hour went into the nine
  `toLocaleTimeString`/`toLocaleString` call sites and an extension theory.
  All were innocent — Node and Chrome matched on every timestamp tested. The
  overlay's `+`/`-` diff is the only thing that identified the real culprit,
  and it should be the *first* thing read, not the last.

Negative money changed shape slightly and deliberately: the sign is placed
outside the symbol (`-Rp 5.000`, as `style: "currency"` produced) by formatting
the absolute value, and `-0` now renders `Rp 0` rather than ICU's nonsensical
`-Rp 0`.

Covered by `src/lib/__tests__/money.test.ts` (10 tests, the first money
formatting tests in the suite). They assert against literal escapes rather than
against `Intl` output — comparing one ICU build to another would pass in CI and
still break in Safari. Verified by setting the separator to `""`, the exact
Safari behaviour: 6 of the 10 fail with `Rp20.000`.

**Still latent, not fixed here** — see *Known issues / debts*: the date call
sites have the same portability exposure via timezone rather than ICU spacing.


### D-116 · The prize catalog had no UI at all

**Owner request, 19 Aug 2026.** Asked which features were built but unreachable;
the catalog was the answer that mattered.

`POST /api/prizes`, `PATCH /api/prizes/:id` and
`PUT /api/shops/:id/prizes/:prizeId/config` shipped in Phase 5 with services,
permission checks and route handlers — and **no client ever called any of
them.** A `grep` for `/api/prizes` across every `.tsx` returned nothing.

This was not cosmetic. The Stock screen's Receive tab picks a prize from a
`<select>` of items that already exist, so on a fresh install the catalog is
empty, Receive has nothing to offer, and **no prize can ever be created except
by the seed script or by hand in SQL.** `redeem-cart.tsx` told the user "a
manager can add them from Stock → Receive", which pointed at a screen that
could not do it. Confirmed against the dev database: `PrizeItem` had 0 rows.

**Built:** `settings/prizes/page.tsx` + `prize-admin.tsx`, and a Settings hub
entry.

**OWNER *and* MANAGER reach it** — owner decision, taken against the
alternative of owner-only. The screen widens no permission: it matches the
`requireManagerOrOwner` gate the two routes have always carried, and stops that
gate being unreachable. Every other `/settings/*` screen is owner-only, so this
is the deliberate exception and the reason is worth keeping: a manager stocking
a branch needs to add the item they just received without waiting on the owner.

**What that costs, and what pays for it.** The catalog is GLOBAL (§4.8, a
closed decision), so a manager editing `ticketCost` reprices at *every* branch,
including ones they do not manage. §4.8 asks for three mitigations; two were
already in `updatePrize` — the audit row and the owner `SystemAlert`. The third
is UI, and it is now the amber block on the reprice field, which names the old
value, the new value, and "at every branch". It renders only when the number
actually changes, matching the service's own `ticketCostChanged` test, so a
rename never cries wolf.

**Two states the row must not conflate:** `shopConfig === null` ("this branch
does not carry it") versus carried with `onHand === 0` ("carried, ran out").
Rendering both as "0 in stock" would send a manager hunting for a delivery that
was never configured. Separate sentences, and the shop-local half is styled
subordinate to the catalog half throughout — the two ideas on this screen are
global and local, and confusing them is the expensive mistake.

**Retire, never delete.** `updatePrize` offers only `isActive`, there is no
DELETE endpoint, and CLAUDE.md forbids hard-deleting anything touching stock —
a prize is referenced by past redemptions and live batches. No button implies
otherwise.

**Scope comes from the work session, not a picker.** `listPrizes` needs a
`shopId` for on-hand and low-stock, and `assertShopAccess` has to pass for a
manager. `includeUnstocked: true` is what makes the screen a *catalog* rather
than the branch's shelf — without it a newly created item is invisible
everywhere and could never be edited or stocked. A test pins that.

**The screen renders `PrizeDTO`, the restricted shape, on purpose.** A
Purchasing manager's `listPrizes` returns `PrizeCostDTO` with a valuation on
it; typing the prop as `PrizeDTO` means this screen cannot reach the cost
fields even though they exist on the object at runtime (§7.5).

**The services had no tests** — Phase 5 shipped them uncovered, and this screen
makes them reachable by a manager for the first time. `prizes.test.ts` adds 29,
and **all seven invariants were confirmed to go red under mutation** as
CLAUDE.md gate 3 requires:

| Broken on purpose | Caught |
|---|---|
| `shopPrizeConfigSchema` made non-strict (per-shop price accepted) | ✅ |
| Alert fires on every update, not only a real reprice | ✅ |
| HQ stock guard removed | ✅ |
| `assertShopAccess` dropped from `setShopPrizeConfig` | ✅ |
| Cost gate bypassed (valuation to a plain manager) | ✅ |
| Duplicate-SKU check skipped | ✅ |
| `includeUnstocked` ignored | ✅ 2 tests |

The strict-schema one is the one to keep: `.strict()` exists so a client
sending a per-branch `ticketCost` is **rejected** rather than having the field
silently stripped, because a silent strip leaves a manager believing they set a
branch price that was never stored.

**Also fixed:** `redeem-cart.tsx`'s empty state now names both steps —
Settings → Prizes to create the item, then Stock → Receive to bring quantity
in. The old wording named only the second and was unactionable on a fresh
install.

**Not done:** `PUT /api/shops/:id/prizes/:prizeId/config` is now tested but
still has no UI caller — see *Known issues / debts*. Per-shop stocking and the
low-stock threshold remain settable only by API.

### What was built

| File | Role |
|---|---|
| `src/app/(app)/settings/prizes/page.tsx` | **New.** The catalog screen. `requireManagerOrOwnerPage`, work-session scope, `includeUnstocked: true`. |
| `src/app/(app)/settings/prizes/prize-admin.tsx` | **New.** Add / edit / retire / restore, client-side search, and §4.8's global-reprice warning. |
| `src/server/services/__tests__/prizes.test.ts` | **New.** 29 tests over `createPrize`, `updatePrize`, `setShopPrizeConfig` and `listPrizes` — the first coverage these services have had. |
| `src/app/(app)/settings/page.tsx` | Hub entry "Prizes", `show: actor.role !== "STAFF"`. |
| `src/app/(app)/customers/[id]/redeem/redeem-cart.tsx` | Empty state now names both steps instead of only Receive. |
| `scripts/verify-prizes.sh` | **New.** 20 checks: all three role paths through the rendered page, the SKU conflict, the reprice alert, the strict-schema rejection, the HQ guard and the cost gate. |

**A note on the verify script's own bug**, because it is the kind that reads as
a product defect: two checks first reported red expecting **400**, and the app
returned **422**. The app was right — `errors.ts` maps `VALIDATION_FAILED` to
422 deliberately. The script was fixed, not the service. Worth writing down: a
red check in a new script is as likely to be the script's wrong expectation as
a real defect, and the way to tell is to read the mapping rather than to
"fix" the code until the script goes green.

### D-117 · Per-shop stocking, and the delivery that vanished

**Owner request, 19 Aug 2026**, immediately after D-116. Closes the debt that
entry opened.

`PUT /api/shops/:id/prizes/:prizeId/config` shipped in Phase 5 with a service
and a permission check, and D-116 added tests — but **no caller anywhere**.
`setShopPrizeConfig` was the only writer of `ShopPrizeConfig` outside
`prisma/demo.ts`, so on any database that had not run the demo seed, that table
was written by nothing at all.

**This was not a missing convenience. It silently broke two features:**

1. **Received stock was invisible.** `receiveBatch` does *not* create a
   `ShopPrizeConfig` row (verified — it writes `PrizeBatch`, `StockMovement`
   and an audit row, nothing else). The On hand tab filters
   `prizes.filter((p) => p.shopConfig?.isActive)`. So a manager could book a
   delivery, get a success toast, and watch the item never appear — with no
   screen in the product able to fix it. The Receive form even labelled such
   items *"(not stocked here yet)"*, naming the problem it could not solve.
2. **The low-stock alert could never fire for them.** `runLowStockScan` reaches
   `lowStockRowsForScope`, which reads the same table. No config row means no
   threshold means no alert, permanently. The Low stock tab's own empty state
   promised "the threshold set for this shop" — a setting with no UI.

**Built:** a **Catalog** tab on the Stock screen, second in the strip, before
Receive — you decide what the branch carries before you receive it.

**Why the Stock screen and not Settings → Prizes.** D-116 put the *catalog*
under Settings because it is global. This is the opposite: `ShopPrizeConfig` is
per-branch, `setShopPrizeConfig` already scopes by `assertShopAccess`, and the
person who needs it is the manager standing in the branch looking at a delivery.
Splitting them along the global/local seam keeps each screen answering one
question. The Catalog tab's intro line and the Settings screen's both say where
the other half lives, because the split is only obvious once you know it.

**Ticket cost is deliberately absent from this tab.** It is global (§4.8) and
lives on the catalog item. The server's schema is `.strict()` so a request that
smuggles one is rejected rather than stripped — pinned by a test and a verify
check.

**Three pieces of wording that are load-bearing:**

- **"Stop carrying" does not destroy stock.** The toast says the units stay on
  the shelf, because "not carried" reading as "written off" is the dangerous
  interpretation for anyone counting inventory. A test asserts the batches
  survive, and it goes red if the service is made to void them.
- **Threshold 0 means "never warn"** (§4.8), which is not the same as an empty
  field. The row renders "No low-stock warning" rather than "Warn at 0".
- **Archived catalog items are not offered.** `receiveBatch` refuses them, so a
  "Carry here" button for one would lead to a dead end. Retiring an item does
  not hide stock already in the branch — that still shows on On hand.

**What I did NOT change, and why it is your call.** §4.9 says staff see only
prizes "configured at *their current shop*", so the config row is a deliberate
gate, not an oversight — auto-carrying on receive would quietly remove a
control the PRD asks for. The Catalog tab makes the gate operable instead of
bypassing it. If you would rather Receive implied "carry it here", that is a
one-line change in `receiveBatch` and a §4.9 amendment; say so and I will make
it.

**Verified in a real browser as a MANAGER**, not just by curl: the tab renders,
"Carry here" moves the row from *Not carried here* to *Carried here* and takes
Items stocked 2 → 3, the inline threshold editor saves, and setting 5 flips the
row to amber "· low" and both Low stock counters 2 → 3. No console errors.
That is the low-stock feature working end to end for the first time.

**Tests:** 3 new (32 total in `prizes.test.ts`, 357 in the suite), and both new
invariants confirmed to go red under mutation as CLAUDE.md gate 3 requires —
voiding batches on unstock, and ignoring the configured threshold. The
receive-then-invisible case is now pinned by a test that asserts `onHand` is 10
while `shopConfig` is null, which is precisely the state that used to be
unreachable from the UI.

`verify-prizes.sh` grows a section 4b (11 checks) covering the whole round
trip, and now also sweeps retired prizes left by earlier runs — it received
real stock, so leaving it dirty would have skewed the Stock screen's counts on
the next run.

### What was built

| File | Role |
|---|---|
| `src/app/(app)/stock/stock-tabs.tsx` | **Catalog tab** — `CatalogPanel` + `CatalogRow`, carried/not-carried sections, inline threshold editor. Receive's hint now points at it. |
| `src/server/services/__tests__/prizes.test.ts` | +3 tests: stock invisible until carried, stock survives unstocking, low-stock flag follows the threshold. |
| `scripts/verify-prizes.sh` | +11 checks (§4b) and a stale-prize sweep. 31 checks total, re-runnable. |

### D-118 · Prize images, and the square that wasn't

**Owner request, 19 Aug 2026.** The last item from the "built but no UI" audit.

`PrizeItem.imagePath` has existed since Phase 0 and `PrizeDTO` carried it all
the way to the redemption screen. Nothing ever set it, and §8.6 — *"grid of
prize cards: image, name, ticket cost, In stock: N"* — rendered text only.
§7.4's route table also lists "image" as a `PATCH /api/prizes/:id` field, which
`updatePrizeSchema` never accepted.

**Two owner decisions, both taken before building:**

**1. Images are served through an authenticated route, not as static files.**
`GET /api/prizes/:id/image`, `requireSettledActor`. A prize photo genuinely is
not sensitive — it is a picture of a teddy bear, unlike a receipt naming a
supplier and an amount, or an attendance photo of a person. The reason to keep
one rule anyway is that "is this image the public kind?" becomes a judgement
someone gets wrong later, and a static path is a permanently guessable URL into
the data directory. Reading is open to **any signed-in role** because staff
need images to redeem; writing is manager-or-owner like every other catalog
mutation.

**2. Full scope — upload AND render on the cards.** Storing an image that staff
never see would have delivered none of §8.6's actual benefit, which is
recognising a prize by sight rather than by name.

**A prize image is catalog data, not evidence — and that drives every
difference from the two existing image services.** `attendance-photo.ts`
watermarks and refuses gallery uploads because it is evidence about a person
being somewhere at a time. `receipts.ts` drops the watermark but keeps the
storage shape because it is evidence of a purchase. This is neither, so:

| | Attendance | Receipt | Prize |
|---|---|---|---|
| Watermark | yes | no | no |
| EXIF-freshness check | yes | no | **no** — a supplier's product shot is a perfectly good prize image |
| Replaceable | no (a record) | no | **yes** — a corrigible attribute |
| Output | 1080 wide | 1600 wide | **600 square** |

What it keeps from both: same data root, same `YYYY/MM/DD/<uuid>` layout, same
traversal-safe resolver, same re-encode through sharp (which strips EXIF — a
phone photo of a prize carries the GPS of the shop), files on disk never bytes
in Postgres.

**The superseded file is deleted on replace.** This is why prize images need no
retention job the way attendance photos do (`photo-retention.ts`): nothing
accumulates. Deletion happens **after** the row is updated, so a failed unlink
can only orphan a file — it can never leave the row pointing at a file that is
already gone, which is the failure the redemption grid would actually notice.

**A real defect the tests caught, worth recording in full.** The obvious
implementation of a square thumbnail is:

```ts
.resize({ width: 600, height: 600, fit: "cover", withoutEnlargement: true })
```

That does **not** produce a square. `withoutEnlargement` clamps each axis to the
source independently, so a 1600x400 source came out **600x400** and 300x900 came
out **300x600**. §8.6 renders a card grid, and a mixed-aspect grid reads as
broken rather than as "this photo is a funny shape". The fix is to centre-crop
to a square first (`.extract()` on the shorter side, after `.rotate()` so a
portrait source is measured upright) and only then resize. Pinned by a
table-driven test over five source shapes including 50x4000, and confirmed to
go red when reverted to the one-liner.

This is the case for writing the test that asserts the *property* you actually
depend on — "width equals height" — rather than the one you assume follows from
the flag names. Nothing about `fit: "cover"` suggests it yields a non-square.

**Verified in a real browser as a MANAGER**, uploading a deliberately 1200x400
image: the thumbnail rendered square, the stored file measured **400x400 with
EXIF stripped**, the redemption card showed the image beside name/cost/stock,
Remove restored the placeholder, and the data directory was left with **zero**
files. No console errors.

**Backups already cover this** — `backup.ts` tars the whole `DATA_ROOT` rather
than a list of known subdirectories, so prize images are archived without
changing that file. Its two comments naming only "attendance photos and
receipts" were updated so the next reader is not misled.

**Tests:** 24 new in `prize-image.test.ts` (381 in the suite), with four
mutations confirmed caught: the non-square regression, skipping the
delete-on-replace, keeping EXIF, and disabling the traversal guard.
`verify-prizes.sh` gains a section 4c (13 checks) that uploads a real 900x300
JPEG through the API and asserts the served bytes are a 300x300 JPEG, that a
replace deletes the old file from disk, and that removing twice is a no-op
rather than a 404.

### What was built

| File | Role |
|---|---|
| `src/server/services/prize-image.ts` | **New.** Store, resolve and delete. Centre-crop to square, EXIF stripped, 600px. |
| `src/app/api/prizes/[id]/image/route.ts` | **New.** GET (any session) · POST (manager/owner) · DELETE. |
| `src/server/services/prizes.ts` | `setPrizeImage`, `clearPrizeImage`, `getPrizeImagePath`. Deletes the superseded file; audits `PRIZE_IMAGE_SET` / `PRIZE_IMAGE_CLEAR`. |
| `src/app/(app)/settings/prizes/prize-admin.tsx` | `ImageField` (add/replace/remove) and `PrizeThumb`. Uploads on choose, with a cache-buster so a replacement shows immediately. |
| `src/app/(app)/customers/[id]/redeem/*` | §8.6's card image; `RedeemablePrize` gains `imagePath`. |
| `src/app/(app)/stock/stock-tabs.tsx` | Thumbnails on the Catalog rows. |
| `src/server/services/backup.ts` | Comments only — corrected to name prize images. |

### D-119 · Manual stock adjustment, and two tests that passed for the wrong reason

**Owner request, 19 Aug 2026.** The last genuinely orphaned endpoint.

`POST /api/stock/adjust` shipped in Phase 4 with a service, a permission check,
an idempotency wrapper — and **no caller and no test**. Until now the only way
stock could move outside a sale, a transfer or a delivery was a full opname. An
opname is a whole-shop physical count; it is the wrong instrument for "a
customer dropped one teddy bear", which is exactly the case §4.16's reason
field is written for.

**Built:** an **Adjust** column on the Stock → On hand table, owner and
manager, matching the route's `requireManagerOrOwner`.

**Two steps, deliberately.** The first picks a direction and a quantity; the
second is the shared `ReasonDialog`, where the change is actually confirmed.
Rolling both into one row-level form would put the reason field beside a
quantity box and make it look optional — and §4.16's whole value is that an
owner reading a movement back months later can tell breakage from theft from a
counting error. The dialog also carries the consequence in words: a removal
says the units come from the oldest batches first *and* what the count becomes;
an addition says the found stock has no cost yet and will sit in the uncosted
queue until priced.

**The direction is a choice, not a sign.** Typing `-3` is easy to get wrong on
a tablet and impossible to notice afterwards. Two labelled buttons carry the
meaning the number alone does not, and the negative is built by the client.

**The Low stock tab deliberately does NOT get the control.** It renders the
same rows through the same component, but it is a read-only view of a warning;
`shopId` is optional on `OnHandTable` and the column only appears when it is
passed.

**The service had NO tests, and it writes stock.** That is squarely inside
CLAUDE.md's "money, stock and balance code needs a test before the phase
closes", so `stock-adjust.test.ts` adds 18 — FIFO order, splitting across
batches, `unitCogsAtConsumption`, the negative-stock guard, the adjustment
batch's `needsCosting` flag, the reason on both paths, and shop scoping.

**Two of those tests initially passed for the wrong reason. Both are worth
recording, because the suite was green either way:**

| Test | Why it was worthless | Fix |
|---|---|---|
| "stops a MANAGER adjusting a branch they do not manage" | The foreign shop had **no stock**, so with `assertShopAccess` deleted the call still threw — `InsufficientStockError`, which *is* an `AppError`, so `rejects.toBeInstanceOf(AppError)` passed. A permission test a stock error can satisfy proves nothing. | Stock the foreign shop, assert the **`FORBIDDEN` code**, and test **both** directions — the positive branch never touches FIFO, so it is the cleaner proof (D-34's rule again). |
| "writes a MANUAL_ADJUST movement carrying the reason" | It used a negative delta. A negative adjustment's movement is written by `consumeFifo`; the **positive** branch writes its own inline. Deleting `reason:` from the inline write left the suite green. | A second test on the positive path. The two deltas write the movement from different places, so one says nothing about the other. |

Both were found by mutation testing, not by review — and the first mutation
attempt was itself wrong: `assertShopAccess(actor, input.shopId);` appears five
times in `stock.ts`, so a naive single replace patched `receiveBatch` instead of
`adjustStock` and reported a false "caught". **Verify the mutation landed in the
function under test before trusting a red or a green.**

Five mutations confirmed caught after the fixes: reversed FIFO order, found
stock not flagged for costing, `assertShopAccess` removed from `adjustStock`,
the reason dropped from the positive-path movement, and the reason dropped from
`consumeFifo`.

**Verified in a real browser as a MANAGER**: the column renders, entering 99
against 10 on hand shows "Only 10 in stock." and keeps Continue disabled,
removing 3 fires the reason dialog and lands 10 → 7, and the database shows one
`MANUAL_ADJUST` movement with the typed reason plus a `StockConsumption` row at
the real 2500 cost. Adding 4 took it to 11 and created an `isAdjustment` +
`needsCosting` batch carrying the reason as its note. No console errors.

`verify-prizes.sh` gains a section 4d (14 checks) covering the mandatory reason,
the zero delta, the STAFF 403, both directions, the negative-stock refusal, the
uncosted flag, idempotent double-submit, and the reason on every movement.

**Two more of the script's own expectations were wrong, and the app was right
both times** — the same lesson as D-116's 400-vs-422. Insufficient stock returns
**409**, not 422, because `InsufficientStockError` is a `CONFLICT`: the stock was
valid when the form was drawn and is not any more, which is a different thing
from a malformed request, and the distinction is what lets a UI say "someone
else just took some" rather than "your input is wrong". And the movement count
is **three**, not four, because the fourth call reused its `Idempotency-Key` —
which is the idempotency check passing.

### What was built

| File | Role |
|---|---|
| `src/app/(app)/stock/stock-tabs.tsx` | `AdjustStockButton` + an Adjust column on On hand. `OnHandTable` takes an optional `shopId`; Low stock omits it. |
| `src/server/services/__tests__/stock-adjust.test.ts` | **New.** 18 tests — the first coverage `adjustStock` has had. |
| `scripts/verify-prizes.sh` | +14 checks (§4d). 58 checks total, re-runnable. |

### D-120 · Settings → Current shop and Settings → Shops merged into one tab

**Owner request, 19 Aug 2026.** Two menu items did one job split across a URL
boundary: `/settings/shop` (singular) was the day-start work-session picker
every role got, and `/settings/shops` (plural) was OWNER-only branch
administration — same subject, different screens, and an owner had to hunt for
branch admin in a place other than the picker they use every day.

**Merged into one screen at `/settings/shops`, split by role inside the page
rather than by URL.** Every role gets the "Current shop" picker
(`ChangeShopForm`, unchanged) at the top. OWNER additionally gets a "Your
branches" section below it — the existing `ShopAdmin` component (create,
deactivate, presets/shifts/staff links), trimmed of its own page-level `<h1>`
since it is now a subsection. STAFF and MANAGER see only the picker, exactly
as before — no read-only branch list was added for them, to avoid dumping
owner-facing operational detail (presets/shifts/staff counts, the empty-branch
warnings) on roles that cannot act on any of it.

**`/settings/shop` (singular) is deleted outright, not redirected.** Its only
two references — the Settings index row and the topbar shop-name link in
`app-shell.tsx` — were both updated to point at `/settings/shops`. Grepped for
any other reference (including `scripts/`, `docs/`) before deleting; none
exist outside historical BUILD-LOG prose, which is left as-is since it
describes what was true at the time.

The Settings index collapses from two rows to one ("Shops"), whose description
is now role-aware: the owner sees "Pick today's shop, add a branch, or change
its options and late grace"; everyone else sees the same "Working at `<shop>`
today" / "Choose today's shop" line the old "Current shop" row showed.

Verified in the browser as MANAGER: `/settings/shops` shows only the picker,
no "Current shop" subheading (that heading is owner-only, since it is pointless
noise when it is the only section), no branch-admin section. The Settings
index shows one "Shops" row with the working-shop description. Not verified
live as OWNER — the seeded owner password had rotated past what `.env`
records and re-deriving it was out of scope for a UI change; the admin
section itself is untouched code (`ShopAdmin`, `CreateShopCard`,
`ShopListItem` all moved without behavioural edits beyond the header trim), so
this rests on code review rather than a live screenshot. Worth a manual check
next time the owner is in the app.

### What was built

| File | Role |
|---|---|
| `src/app/(app)/settings/shops/page.tsx` | Rewritten. Renders the picker for every role, plus `ShopAdmin` for OWNER only. |
| `src/app/(app)/settings/shops/change-shop-form.tsx` | Moved from `settings/shop/`. No logic changes, doc comment updated. |
| `src/app/(app)/settings/shops/shop-admin.tsx` | Trimmed its own `<h1>`/page description now that it renders as a subsection. |
| `src/app/(app)/settings/page.tsx` | Two rows ("Current shop", "Shops") collapsed into one role-aware "Shops" row. |
| `src/components/app-shell.tsx` | Topbar shop-name link repointed from `/settings/shop` to `/settings/shops`. |
| `src/app/(app)/settings/shop/` | **Deleted.** |

### D-121 · OWNER never needs a reason to change shop, even with prior records

**Owner request, 19 Aug 2026, immediately after D-120.** §4.7's rule —
"requires a reason if any records were already created under the old shop
that day" — is written role-agnostic in the PRD, but the reason it exists is
to explain **staff covering for each other**: a manager or a staff member who
recorded a sale at Branch 1 and then jumps to Branch 2 needs to say why, so a
later reader of the audit log can tell a legitimate shift swap from something
worth asking about.

**That is not what it means when the owner does it.** The owner moves between
branches to *monitor* them — checking Branch 2's till while Branch 1 shows
work recorded under their own account from earlier — not to work a shift
under a false shop. Making the owner type a reason every time is friction with
no matching liability: nobody needs to be told why the owner is looking at a
different branch.

**`changeWorkSession` (`src/server/services/work-session.ts`) now short-circuits
`priorRecords` to `0` for `actor.role === "OWNER"`** before the reason check,
rather than skipping the check itself — the audit row is still written on
every change, `reason: null` when none is given. The distinction matters:
the record of *that the owner moved* is preserved, only the mandatory
*explanation* is waived. Every other role's behavior is byte-for-byte
unchanged — the branch that computed `priorRecords` for non-owners was not
touched, only wrapped in the role check.

No client change was needed: `ChangeShopForm` (`src/app/(app)/settings/shops/
change-shop-form.tsx`) only shows the reason box when the server's response
carries `details.recordsAtOldShop`, which the server now never sends for an
owner.

**New test file** `src/server/services/__tests__/work-session.test.ts` — this
was previously untested (`changeWorkSession` shipped in Phase 1 with no
service-level test, only the API route implied by §7.1). Four tests: a
MANAGER with a prior sale today is blocked without a reason and unblocked with
one; a MANAGER with no prior records is never asked; and — the one that
matters for this decision — an OWNER with a prior sale today changes shop with
**no** `reason` in the input and the resulting audit row still gets written
with `reason: null`. Verified this last test actually exercises the new
branch by reverting the `actor.role === "OWNER"` guard and confirming it fails
(it does, with the same `VALIDATION_FAILED` a non-owner would get) before
restoring the fix — CLAUDE.md's "a test you have not seen fail proves
nothing," same discipline as D-119.

Not re-verified live in the browser: the dev database's MANAGER test account
(`manager1`) is currently assigned to only one shop (`BR-1`), so there is no
second branch to switch to and manually trigger the reason prompt against.
The automated test above exercises the same code path against real database
rows, including the audit-log write, so this rests on that rather than a
screenshot. Confirmed there is no OWNER-specific UI to check — the picker
component (`ChangeShopForm`) is unchanged and role-agnostic; it just never
receives a `reasonRequired` signal from the server for this role now.

---

### D-122 · Role becomes per-shop — MANAGER/STAFF move to UserShop, OWNER stays a global flag

**Owner request, 19 Aug 2026.** Not a numbered PRD phase — every phase
through 10 is already shipped (see Phase status above). This is a
**retroactive, cross-cutting schema and permission-model change**, triggered
by rebuilding Settings → Users as Settings → Employees against a reference
UI: a per-shop checklist where each shop row carries its own role dropdown
("Staff at Shop A, Manager at Shop B, same account"), plus a search bar over
the shop list.

**This reverses PRD §3's original text — "Role is a property of the user
account; a user has exactly one role" — deliberately, not by oversight.**
The PRD was updated in the same change (§3, §3.4, §7.5, §6, §7.9) rather than
left to drift, per CLAUDE.md's own precedence rule that this file wins where
the two disagree; the point of updating the PRD too is that a future reader
searching the PRD alone should not find the stale claim. **If you land here
because something about role/cost logic looks wrong: read this entry before
"fixing" it.** The screenshot-driven interaction model was confirmed with the
owner across two rounds before any code was touched — first that adopting it
means a real architectural change (~40 call sites), not a UI-only refresh;
second, that it means reopening the PRD's "one role" decision on purpose.

#### Why role could not stay global

`role` (`OWNER | MANAGER | STAFF`) lived as a single required column on
`User`, fed into Better Auth via `additionalFields`. `UserShop` was a bare
`{userId, shopId}` membership join with no role of its own. Under that shape
there is no way to represent "MANAGER at Branch 1, STAFF at Branch 2" on one
account — the screenshot's whole interaction model is impossible without
moving role off `User`.

#### Schema shape

`UserShop` gained the role:

```prisma
model UserShop {
  id           String  @id @default(cuid())
  userId       String
  shopId       String
  role         Role                    // MANAGER | STAFF only — DB CHECK below
  canEnterCost Boolean @default(false) // meaningful only when role = MANAGER
  user         User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  shop         Shop    @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([userId, shopId])
  @@index([shopId])
  @@index([userId])   // new — every per-shop-role read fans out from userId
}
```

A hand-written `CHECK ("role" <> 'OWNER')` constraint (Prisma cannot express
a partial-enum constraint declaratively) makes "OWNER never gets a UserShop
row" a database-enforced invariant, not just an application convention —
matching what `setShopAssignment` already refused before this change.

`User` lost `role Role` and `canEnterCost Boolean`, gained `isOwner Boolean
@default(false)`. **`isOwner: boolean` was chosen over a nullable `role:
Role?`** specifically so a stray `.role` reference on a `User`/`Actor` object
is a compile error, not a silently-`null` read — a boolean has no third state
to misuse. `@@index([role, banned])` became `@@index([isOwner, banned])`.

**Two migrations, not one**, both committed (`prisma/migrations/`, never
`db push`, per CLAUDE.md rule 8):

1. `20260819125417_per_shop_roles` — additive only. Added `UserShop.role`/
   `canEnterCost` (nullable, backfilled, then `SET NOT NULL`), added
   `User.isOwner` (backfilled from `role = 'OWNER'`), added the CHECK
   constraint and the new indexes. Verified before writing it that zero
   existing `UserShop` rows belonged to an OWNER (the pre-existing guard in
   `setShopAssignment` already prevented that) — the migration deletes any
   found regardless, defensively. At the end of this step the app still ran
   unmodified against the old columns; nothing broke yet. Backfill was
   verified by hand against the dev database's 4 seed accounts (owner,
   manager1, staff1, budak) — every `UserShop` row's new `role`/
   `canEnterCost` exactly matched the user it belonged to, and `isOwner` was
   `true` only for the seed owner.
2. `20260819132655_drop_legacy_user_role` — dropped `User.role`,
   `User.canEnterCost`, and the old `@@index([role, banned])`, only after
   every call site was confirmed to read `UserShop`/`isOwner` instead (full
   green typecheck/lint/test pass first). This two-step split is new to this
   codebase's migration practice — worth naming explicitly since every prior
   migration here was a single step: it exists so a destructive column drop
   is never in the same commit as the many call-site rewrites depending on
   it, which would make a partial rollout (or a bisect) far harder to reason
   about.

Both migrations were written by hand rather than via `prisma migrate dev`
directly — that command refuses to run non-interactively when it detects a
destructive change (a real safety feature, not a bug), so the generated
`migration.sql` was reviewed and edited before being applied via
`prisma migrate deploy`, which does not prompt.

#### Actor shape

```ts
export interface ShopRole {
  role: "MANAGER" | "STAFF";
  canEnterCost: boolean;
}

export interface Actor {
  // ...
  isOwner: boolean;                    // replaces role: Role
  shopRoles: Map<string, ShopRole>;    // replaces assignedShopIds + canEnterCost
  // ...
}
```

`assignedShopIds` is no longer a stored field — it is a derived helper,
`assignedShopIds(actor) => [...actor.shopRoles.keys()]`, so the many call
sites that only ever cared about shop *membership*, not role, needed a
one-line rewrite instead of a structural one. `getActor()`
(`src/server/auth/context.ts`) now fetches `{shopId, role, canEnterCost}`
per `UserShop` row and builds the map; `isOwner` comes straight off
`user.isOwner`.

**Rejected alternative**: deriving a single `role` field from "the role at
`defaultShopId`" for backward compatibility with old call sites. Rejected
because it reintroduces exactly the bug this change removes — a
MANAGER-at-A/STAFF-at-B account's apparent role would depend on an unrelated
field (which shop happens to be their default), and new code would be too
tempted to read that shortcut instead of the real shop-scoped check.

#### Guards

`requireOwner()`/`requireOwnerPage()` are nearly unchanged, now checking
`actor.isOwner`. `requireRole(...roles)`/`requireManagerOrOwner()` (formerly
unscoped — "OWNER or MANAGER, anywhere") were replaced with
`requireShopRole(shopId, ...roles)` (`src/server/auth/guards.ts`,
`page-guard.ts`'s `requireShopRolePage`), which resolves the actor's role
*at that specific shop*. A narrower, explicitly-documented-as-weak
`requireManagerOrOwner()`/`requireManagerOrOwnerPage()` survives for the
handful of genuinely shop-unscoped screens (reports index, dashboard
dispatch) that only need "is this person privileged at all" before a later,
real per-shop check narrows the data — every remaining use is commented to
say so, since pairing it with a real check downstream is easy to forget.

#### The cost-visibility gate — the highest-stakes rewrite

```ts
export function canSeeCostForShop(actor: Actor, shopId: string): boolean {
  if (actor.isOwner) return true;
  const sr = actor.shopRoles.get(shopId);
  return sr?.role === "MANAGER" && sr.canEnterCost === true;
}
```

Before this change, `canEnterCost` was a single flag that happened to
compose correctly with a MANAGER's shop *membership* list — it read as
per-shop without actually being stored that way, since a manager only ever
had one role and the flag applied everywhere they were assigned. After this
change `canEnterCost` is genuinely stored per `UserShop` row, so it can
finally vary: a manager can hold Purchasing at Branch 1 and not at Branch 2.
`reports.ts`'s existing `assertCanSeeCost`/`canSeeCostForScope` (`.every()`
over every shop in a resolved scope) needed **no logic change** — it already
composed correctly on top of `canSeeCostForShop`, which is exactly why it
was the template this rewrite generalized from. **Fixed as a side-effect of
this pass**: `stock.ts`'s `listUncostedBatches` used the bare, whole-actor
`canSeeCost(actor)` on a shopId-filterable queue when called with no
`shopId` — under the old model this was merely imprecise (a Purchasing
manager's full membership list, not their cost-granted subset), but under
the new per-shop model it would have been a real leak (cost visible at a
shop the manager holds no Purchasing grant for). Now filters to
`shopRoles.entries().filter(role === MANAGER && canEnterCost)`.

**Proven, not assumed** (CLAUDE.md's "a test you have not seen fail proves
nothing," §15 rule 3): `src/server/services/__tests__/employees.test.ts`'s
`per-shop role isolation (D-122)` group asserts a MANAGER with Purchasing at
shop A and plain STAFF at shop B gets `canSeeCostForShop(actor, shopA) ===
true` and `canSeeCostForShop(actor, shopB) === false`. Broken on purpose by
temporarily making `canSeeCostForShop` fall through to the whole-actor
`canSeeCost(actor)` (i.e. reintroducing the shape of the old bug) —
confirmed the test failed with `expected false, got true` on the `shopB`
assertion — then reverted. The suite (`npm test`, 405 tests / 24 files) was
green both before the deliberate break and after the revert.

#### Call-site sweep — the shape of the ~40-file change

Every bare `actor.role === "OWNER"` / `!== "OWNER"` across `src/server` and
`src/app` fell into one of a few repeating shapes, mechanically rewritten by
pattern rather than file-by-file:

- **Whole-system, OWNER-only** (`backup.ts`, `shops.ts`, `settings.ts`,
  `customers.ts`, `audit-log.ts`, `ticket-reports.ts`, `reports-export.ts`,
  ~15 sites): `!actor.isOwner`. No behavior change.
- **Filter-shape** ("OWNER sees all, else scope to shops") in `expenses.ts`,
  `redemptions.ts`, `stock.ts`, `transfers.ts`: the shop-scoping half became
  `actor.isOwner ? {} : { shopId: { in: assignedShopIds(actor) } }` —
  mechanical, since shop *visibility* was always membership-based, never
  role-differentiated. But the outright-forbid half of several of these
  (`expenses.ts`'s dozen `STAFF` checks) was **not** mechanical: a bare
  `actor.role === "STAFF"` would have wrongly blocked a STAFF-at-A/
  MANAGER-at-B account acting at shop B, so each became a real per-shop
  check (`actor.shopRoles.get(shopId)?.role !== "MANAGER"`). This is the one
  sub-category where "mechanical" undersold the actual diff.
- **True per-shop fusions** (small, highest-value): `attendance.ts`'s
  `assertCanReadAttendance` already combined role with a bound `shopId` and
  became a single map lookup; `sales.ts`'s `assertVoidable` collapsed an
  OWNER-bypass-then-separate-`hasShopAccess`-call into one `roleAtShop`
  check; `work-session.ts`, `api/marbles/adjust`, `api/tickets/adjust` each
  gained a real per-shop check where they previously ignored an
  already-bound `shopId`.
- **`writeAudit`/`AuditLog.role`** (`src/server/audit.ts`) — its own pass,
  not folded into the above (44 call sites, verified by grep). `writeAudit`
  now resolves the role to snapshot from whichever shop the action already
  concerns (`input.shopId ?? actor.workSession?.shopId`), falling back to
  `"OWNER"`-or-`null` when no shop is in scope — no call site needed a
  signature change, since the resolution happens inside `writeAudit` itself
  from data it already receives. `balances.ts`'s `recordDrift` (a second,
  independent audit-log writer for reconciliation) needed its own fix: its
  `ReconciliationPrincipal` union type (`Actor | {kind: "SYSTEM"}`) used
  `"role" in principal` as a discriminant, which stopped working once
  `Actor` no longer has a `role` key — switched to `"isOwner" in principal`.
- **`reports.ts`'s `resolveScope()`** — the single function nearly every
  report calls — done last among services, once every consumer's
  expectations were settled. Its OWNER branch became `actor.isOwner`; its
  scoped branch became `assignedShopIds(actor)`. Shop visibility itself did
  not change, only where the id list comes from.
- **Display-only** (report page one-liners, `dashboard-view.tsx` reading a
  service-returned DTO field rather than `actor.role` directly,
  `settings/audit-log/page.tsx` reading the separate, unaffected
  `AuditLog.role` snapshot column): mechanical swaps or no change needed.

`app-shell.tsx`'s bottom nav (three role-keyed tab sets) is per-account, not
per-shop, and role is now per-shop — it now picks OWNER/MANAGER/STAFF tabs by
`isOwner` / "is MANAGER at at least one shop" / else, a deliberate
approximation since the nav is UI convenience only and every destination
re-checks the real per-shop role server-side regardless.

#### Settings → Employees

`services/users.ts` → `services/employees.ts` (full rewrite, not a rename —
`toUserDTO` → `toEmployeeDTO` returns `shopRoles: {shopId, shopName, role,
canEnterCost}[]` instead of one flat `role`; `createUserSchema`/
`updateUserSchema` → `createEmployeeSchema`/`updateEmployeeSchema` accept a
`shopRoles` array with per-entry `role`/`canEnterCost` instead of a single
`role` + flat `canEnterCost`). `/api/users*` → `/api/employees*`.
`/settings/users` → `/settings/employees`, with a redirect stub left at the
old path for anyone with it bookmarked (`settings/users/page.tsx` now just
`redirect("/settings/employees")`).

**Wholesale-replace vs. single-pair — kept both, matching the split the
codebase already made for this exact reason (D-107 vs D-109).** The
Employees screen's edit form keeps `updateUser`'s wholesale-replace
semantics for `shopRoles` — the whole point of that screen is "here is the
complete desired shop-role map, save it," matching the screenshot's
checklist interaction, and D-109's original rationale gets *stronger* here:
the form must render every shop the employee currently holds **with its
current role pre-selected**, not merely checked, so a save cannot silently
downgrade a role nobody was looking at. The single-shop staff screen
(`settings/shops/[id]/staff`, D-107's `setShopAssignment`) keeps its narrow
one-(user,shop)-at-a-time semantics and gained a role parameter —
`setShopAssignment(actor, shopId, userId, assigned, {role?, canEnterCost?})`
— still no read-modify-write race, now able to change the role at that one
shop without touching any other. Both paths write through the same
underlying `UserShop` upsert/delete.

**UI**: `npx shadcn add checkbox select` — both were genuinely absent from
`src/components/ui/` before this change (only button, card, dialog, field,
input, label, separator, sonner existed), confirmed by listing the directory
before running the command, not assumed. The new "Shop access · set a role
per shop" section (`employee-admin.tsx`'s `ShopAccessFields`) matches the
reference screenshot's interaction — one row per shop, a checkbox, a role
`Select` defaulting to Staff and disabled until checked, a Purchasing
sub-checkbox that only appears when that row's role is Manager — styled with
this app's existing shadcn components, not the screenshot's visual style. A
search bar filters the shop checklist in both the create and edit forms, and
a second search bar (over name/username/shop) was added to the existing-
accounts list, matching the owner's explicit ask for the latter.

#### Tests

`users.test.ts` → `employees.test.ts` (renamed, not just edited — the
fixture shape changed too much to be a patch). `makeUser(role, opts)` →
`makeEmployee({isOwner} | {shopRoles: {shopId, role, canEnterCost}[]})`. All
5 pre-existing groups (self-lockout, shops/permissions editing, deactivation,
password reset, permissions/immutability) got their fixtures and assertions
updated to the new shape with no behavior change. New: a
`per-shop role isolation (D-122)` group (the cost-gate proof above, plus a
test that `requireShopRole` grants/refuses correctly for a MANAGER-at-B/
STAFF-at-A account depending on which shop is asked about, plus a test that
a single account can simultaneously read `MANAGER` at one shop and `STAFF`
at another from `actor.shopRoles`).

A shared `makeActor`/`makeActorWithUser` pair was added to
`__tests__/helpers.ts` during this change — every other test file
(`attendance`, `stock-adjust`, `prizes`, `prize-image`, `shifts`,
`transfers`, `work-session`, `expenses`, `reports`, `shops`, plus
`opname.test.ts` and `redemption.test.ts`, found only by running the full
suite since their hand-built `Actor` casts hid the missing `shopRoles` field
from `tsc`) had its own copy of near-identical actor-building boilerplate
before this change; several were migrated onto the shared helper as part of
this sweep rather than patched in place, since fixing 11 near-duplicate
`role`/`assignedShopIds` constructions independently would have been the
same bug fixed 11 different, slightly-inconsistent ways. **Typecheck alone
did not catch every fixture** — `opname.test.ts` and `redemption.test.ts`
both used `as unknown as Actor` casts that silenced the compiler while
leaving `shopRoles` genuinely `undefined` at runtime; both surfaced as
`TypeError: Cannot read properties of undefined` only when `npm test`
actually ran. Lesson for whoever touches `Actor`'s shape again: `tsc` is not
sufficient proof that every fixture was found — run the real suite.

#### Verification run, in order

1. `npm run typecheck` — clean (zero errors) after the full sweep.
2. `npm run lint` — clean.
3. `npm test` — 405 tests / 24 files, all green, including the deliberate
   break-and-revert on the cost gate described above.
4. `docker compose build` — succeeded (`exit 0`), confirming the Linux
   case-sensitive build compiles every renamed route
   (`/settings/employees`, `/api/employees*`) cleanly; Docker Desktop was
   not running at the start of this session and was started for this check.
5. PRD reconciled: §3 (role is per-shop for MANAGER/STAFF, global for
   OWNER), §3.4 (table intro notes the per-shop reading), §7.5 (Purchasing
   is per-shop, updated code sketch), §6 (`User`/`UserShop` model text
   matches the schema exactly), §7.9 (route table renamed), §8.10 (Settings
   index copy renamed to Employees).

**Additionally smoke-tested against the real dev database, outside the test
suite**: the mixed-role scenario specifically (one account MANAGER at one
shop, STAFF at another) was created for real — a `User` row plus two
`UserShop` rows with different roles — and `getActor()`'s exact query shape
was run by hand against it, confirming `canSeeCostForShop` returns `true`
for the Purchasing-granted shop and `false` for the other, before the test
rows were deleted.

**Not yet done, and listed in Known issues below**: a click-through in an
actual rendered browser, as OWNER, a MANAGER-at-one-shop, a
STAFF-at-another-shop, and the mixed-role account above. No browser
automation was available in this session to drive one. CLAUDE.md's "load
every new page as each role that can reach it" is not fully satisfied by the
automated suite plus the database-level smoke test alone for a change this
shaped — a rendered page can still surface something the tests do not, per
D-34's precedent.

---

### D-123 · Exactly one owner, fixed at bootstrap — and a real bug this surfaced

**Owner request, 20 Aug 2026.** Settings → Employees still let the owner tick
an "Owner" checkbox on the create form, and toggle it on the edit form, to
promote any employee to OWNER or demote the current one (guarded only by a
"last active owner" check). The owner asked for that removed: **there is
exactly one owner, created once when the system is set up, and nobody should
be able to create or promote another from this screen.**

Changed, in `src/server/services/employees.ts`:

- `createEmployeeSchema` no longer accepts `isOwner` at all. `createEmployee`
  always creates the account with `isOwner: false` — an employee created here
  is always MANAGER/STAFF.
- `updateEmployeeSchema` no longer accepts `isOwner`. `updateEmployee` can
  edit an owner's name/phone/active-state, but can never change their role or
  give anyone else the flag. The last-active-owner lockout guard stays — an
  owner account can still be deactivated in principle, so the "don't leave
  zero owners" check still has a job — but it now checks only `isActive`, not
  a demotion path that no longer exists.

Changed in `employee-admin.tsx`: the Owner checkbox is gone from both the
create card and the edit form. An owner's edit panel instead shows a
read-only "Owner … set up when the system was installed, and cannot be
changed here" box; `shopRoles` is never sent for that account at all (not
even `[]`) rather than being conditioned on a checkbox that no longer exists.

**The one remaining way to become OWNER is the seed script's bootstrap check**
(`prisma/seed.ts`: create the `SEED_OWNER_USERNAME` account only if no user
with that username exists yet). See the deploy section below for what that
means operationally.

#### The bug this surfaced: the admin plugin cannot create ANY user, on ANY path

Verifying this by actually clicking "Create account" in the browser — not
just running the test suite, which never exercises the real Better Auth
internal adapter (see the note on `makeEmployee` below) — `createEmployee`
500'd. Separately, `npm run db:reset` had never been run in this session and
failed too, at the seed script's owner-creation step, with the same
underlying error: **`Unknown argument 'role'. Did you mean 'name'?`**

Root cause: `adminPlugin()` (registered in `auth.ts`, kept only for its ban /
password-reset endpoints per D-4 — `adminRoles` is deliberately never wired
up) installs a `databaseHooks.user.create.before` hook that unconditionally
stamps `role: options?.defaultRole ?? "user"` onto **every** user creation.
This runs inside Better Auth's internal adapter itself, so it fires
regardless of entry point — `auth.api.createUser` (what the seed script used)
and `ctx.internalAdapter.createUser` directly (what `createEmployee` uses)
are both affected equally. It is not specific to the admin-plugin HTTP
surface that D-4 already reasoned about avoiding.

Our `User` model has no `role` column — D-4's whole point was replacing it
with `isOwner` — so Prisma rejected the insert every time. This is a
framework/schema mismatch that predates this session and was never caught,
because **no test ever calls the real internal adapter**: `employees.test.ts`
builds its fixture users with a direct `prisma.user.create(...)` in
`makeEmployee`, which bypasses Better Auth (and its hooks) entirely. The unit
tests were never able to catch this class of bug — proving `createEmployee`
and the seed's owner bootstrap actually work requires driving them for real,
which is why this got caught here and not earlier.

**Fix:** add `role String?` to `User` in `schema.prisma` — an inert column
the admin plugin's hook can write to and that nothing in this codebase reads
for permission decisions (`isOwner` and `UserShop.role` remain the only roles
that matter; see the comment on the column itself). Migration
`20260820051620_add_admin_plugin_role_column`. Also fixed `prisma/seed.ts` to
create the owner via `ctx.internalAdapter.createUser` +
`ctx.internalAdapter.linkAccount` — the same pattern `createEmployee` already
used — instead of `auth.api.createUser`, for the same reason `employees.ts`
avoids it (D-4): the admin-plugin HTTP endpoint is gated by `adminRoles`,
which we deliberately never populate, so it would 403 in a real request even
once the schema is fixed. `auth.api.createUser` only "worked" for the seed
script because seed scripts call the auth object in-process, bypassing the
route-level gate that would stop it in production.

**Verified for real, not just by the suite:** reset the dev DB
(`npm run db:reset --force` failed until this fix went in, then succeeded),
logged in as the freshly-seeded owner through the browser, forced through the
mandatory first-login password change, opened Settings → Employees, created
a MANAGER/STAFF account through the actual create form (500'd before the
fix, succeeded after — "Budi Santoso can now sign in as 'budi'"), opened both
the owner's and the new employee's edit panels to confirm the checkbox is
gone from both, then deleted the test account by hand. Also re-ran
`npm run typecheck`, `npm run lint`, and the full `npm test` suite (405
passing) after every change in this entry.

**Not done:** `docker compose build` — Docker Desktop's daemon was not
running on this machine during this session, so the Linux-vs-macOS
case-sensitivity check CLAUDE.md asks for is still outstanding for this
change. Start Docker and run it before this is trusted in a Linux/production
build.

#### What this means for going to production

The owner asked, separately, how the first owner account gets created on a
fresh deploy. There is no separate onboarding UI — it is the seed script:

- `prisma/seed.ts` reads `SEED_OWNER_USERNAME` / `SEED_OWNER_PASSWORD` from
  the environment (`requireEnv` — it throws rather than default to a guessable
  password) and creates that one account, with `isOwner: true` and
  `mustChangePassword: true`, **only if no user with that username already
  exists**. Every other seed step (`Shop`, `AppSetting`, `SalePreset`,
  `Shift`, `ExpenseCategory`) is an `upsert`, so the whole script is safe to
  run on every container boot — `npm run db:seed` runs after every
  `migrate deploy` (see the Docker entrypoint / `package.json`).
- To stand up a fresh production instance: set `SEED_OWNER_USERNAME` and a
  strong `SEED_OWNER_PASSWORD` (8+ chars, checked) in the production `.env`
  before first boot, run migrations, let the seed step run once. Log in as
  that account — Better Auth's `mustChangePassword` flag forces the
  "Choose your password" screen on that very first login (verified above),
  so the seeded password is never the one actually in use afterward.
- There is deliberately no in-app "create the first owner" flow, and after
  this session's change there is no way to mint a *second* owner from inside
  the app at all — Settings → Employees can only create MANAGER/STAFF now.
  If the owner ever needs a second owner account (e.g. handing off the
  business, or a break-glass account), the only path is editing
  `SEED_OWNER_USERNAME` to a new value and re-running the seed step by hand
  against production — which is a deliberate, manual, audited action, not
  a self-service one. Worth flagging to the owner explicitly if that need
  ever comes up; nothing about that path exists yet as a script.

---

### D-124 · Expense entry gets a date override — a deliberate, narrow exception to "the client never sends businessDate"

**Owner request, 20 Aug 2026,** as part of the Expenses/Expense-categories UI
merge (recording an expense and managing categories both moved into modals on
the Expenses screen). The owner asked for a manual date picker on the
"Record expense" modal, defaulting to today but overridable — the real case is
a receipt that gets entered the morning after, which should land in the
report it actually belongs to, not today's.

This runs straight into CLAUDE.md's rule 6 and D-18: `businessDate` is
computed by the server, the client never sends it. That rule exists because a
cost recorded against the wrong reporting day is a different event, not a
typo — which is also why `updateExpense` still refuses to let the OWNER change
the date on an *existing* row (`edit-expense.tsx`'s docstring). D-124 does not
reopen that: editing an already-recorded expense's date is still blocked. This
is only about the date an expense is recorded *as*, at entry time, once.

**What shipped, in `src/server/services/expenses.ts`:**

- `createExpenseSchema` gained an optional `businessDate: YYYY-MM-DD`.
- `createExpense` still computes today's business date itself
  (`businessDateFor`, shop timezone + the global day-start hour, unchanged).
  If the client sends a `businessDate`, it is used **only as a value to
  validate, never trusted outright** — reject with `VALIDATION_FAILED` if it
  is after today. There is deliberately **no lower bound**: the owner
  reconciling a stack of old receipts is exactly who asked for this, and an
  arbitrary cutoff (7 days, 30 days) would have turned into a second support
  request the moment someone hit it.
- Both OWNER and MANAGER get the override — it follows who can record an
  expense at all, not a narrower owner-only carve-out. A Purchasing-style
  split (owner backdates, manager doesn't) was considered and rejected: there
  is no cost-visibility reason to withhold it, and the same "enter it the next
  morning" case applies to whoever is doing the entering.

**UI (`add-expense.tsx`):** a `type="date"` field, `value` defaulting to the
page's business date, `max` pinned to the same value so the native picker
cannot even offer a future date — belt-and-suspenders with the server check,
not a replacement for it. The request body only includes `businessDate` when
it differs from today, so the common case (recording today) is byte-for-byte
what it was before this change.

**Verified for real:** backdated an expense through the actual modal against
the dev database (`2026-08-10`, while the business date was `2026-08-20`) and
confirmed it landed with that date, appeared correctly in the "This month"
filtered history, and the running total picked it up. Broke the future-date
guard on purpose (`if (false)` in place of the comparison), confirmed the new
"refuses a future date" test in `expenses.test.ts` goes red, then reverted —
CLAUDE.md gate 3. The stale test that used to assert "the schema strips
`businessDate`" was rewritten into three: defaults to today when omitted,
honours an explicit past date, refuses a future one. Full suite (407 tests),
`typecheck`, `lint` and `docker compose build` all pass.

### D-125 · New-shop form drops "allow custom sale amounts" and the clock-out photo toggle

**Owner request, 20 Aug 2026.** Two changes to `CreateShopCard` in
`shop-admin.tsx`, Settings → Shops:

- **"Allow custom sale amounts" removed from the form.** The owner does not
  want this option offered at branch creation. The `allowCustomAmount` field
  and its `Decisions already made` row (a sale records money only) are
  untouched — the form simply no longer sends it, so it keeps its schema
  default of `false` on every new shop. It is still reachable via
  `PATCH /api/shops/:id` if a future request needs it back; there is no UI
  writer for that path (see the "Shop admin has no edit form" debt below).
- **Clock-out photo is now always on, not a toggle.** Every shop should
  require it, so `requireClockOutPhoto`'s Zod default in
  `src/server/services/shops.ts` flipped from `false` to `true`, and the
  create form now sends `requireClockOutPhoto: true` unconditionally instead
  of exposing a checkbox. `shops.test.ts`'s defaults test was updated to
  match. This is a default-and-hide, not a removal of the field or a
  hardcoded constant elsewhere — `PATCH /api/shops/:id` can still set it to
  `false` for a branch that genuinely needs an exception, again only via the
  API today.

Both toggles' underlying schema fields, DB columns and PATCH support are
unchanged; only what the *create* form offers and defaults to changed. `Toggle`
the component is still used for "Allow direct marble transfers," the one
option left in that fieldset.

Verified: `npm run typecheck`, `npm run lint`, and `npm test -- shops` (42/42)
all pass after the change.

### D-126 · Shop edit form — closes the "no edit UI" debt from D-101

**Owner request, 20 Aug 2026,** immediately after D-125: once the create
form's toggles were being pruned, the owner asked whether name, address,
phone, late grace, and the toggles could be changed on an *existing* branch —
they had assumed this already existed. It didn't: `getShop`/`updateShop` and
`PATCH /api/shops/:id` have existed since Phase 6/D-101, fully tested, with no
UI caller. Closes the "Shop admin has no edit form" debt.

**New route:** `/settings/shops/[id]/edit` (`page.tsx` + `edit-shop-form.tsx`),
alongside the existing `presets`/`shifts`/`staff` per-shop screens — same
`requireOwnerPage` guard as `presets` (real 403, not a redirect, per D-64/D-33
precedent already established on that screen). Linked from a new "Edit" button
on the shop list in `shop-admin.tsx`, between Staff and Deactivate.

**Fields exposed, confirmed with the owner before building:** name, address,
phone, late grace, allow direct marble transfers, require clock-out photo.
**Deliberately excluded**, matching D-125 and D-3:

- **`code`** — shown, disabled, with the same immutability explanation as the
  create form's help text. Never sent in the PATCH body.
- **`allowCustomAmount`** — owner does not want this option surfaced anywhere
  right now (D-125). Still reachable only via the raw API.
- **`timezone`** — not offered on the create form either; adding it only to
  edit would make edit the odd one out for no requested reason. Still
  reachable only via the raw API.
- **`isActive`** — deliberately left on the existing Deactivate/Reopen button
  in the shop list rather than duplicated here, since that button already
  carries the last-branch and HQ-cannot-deactivate refusal messages
  (`updateShop`'s guards) and a second call site for the same state risks
  drifting from those messages.

**Verified for real**, against the running dev server (owner already
authenticated in the connected browser session): opened Edit for the seeded
`Branch 1`, changed late grace 5 → 10 and checked "Require a clock-out photo,"
saved, confirmed the success toast and the updated grace on the list ("10 min
grace"), then reopened Edit and reverted both fields back to their original
values (5, unchecked) and saved again — the list shows "5 min grace" as before
this session. No stray test data left behind; this exercised a real
`PATCH /api/shops/:id` round trip end to end, not just the form rendering.

`npm run typecheck`, `npm run lint`, and the full suite (407/407) all pass —
no service or schema change was needed, only the new page and form.

### D-127 · Create/Edit shop become modals, superseding D-126's route

**Owner request, 20 Aug 2026,** minutes after D-126 shipped: the owner
expected "New shop" to already be a popup, matching the Expenses screen's
"Record expense" / edit-row modal pattern (`add-expense.tsx`/
`edit-expense.tsx`, part of the Phase 11 batch). It wasn't — create was an
inline card that replaced the page content, and the brand-new edit screen
from D-126 was a full route.

**What changed, entirely in `shop-admin.tsx`:**

- `CreateShopCard` → `CreateShopDialog`. Same fields and validation as before;
  wrapped in `Dialog`/`DialogTrigger`/`DialogContent` from
  `components/ui/dialog.tsx`, the same primitives the expense modals use. The
  form's submit button lives in `DialogFooter`, outside the scrolling form
  body, wired to the form via `form="create-shop-form"` rather than nesting a
  button inside the footer's own markup — copies the expense dialogs' shape.
- **New `EditShopDialog`**, one per row, replacing the D-126 route entirely.
  `/settings/shops/[id]/edit` (`page.tsx` + `edit-shop-form.tsx`) is deleted —
  its guard (`requireOwnerPage`) and fields (name, address, phone, late grace,
  allow direct transfer, require clock-out photo; code shown disabled;
  `allowCustomAmount`/`timezone`/`isActive` excluded, same reasoning as D-126)
  moved into the dialog unchanged. Values reset from the shop row on every
  open/close, matching `edit-expense.tsx`'s reset-on-open pattern, so a
  cancelled edit never leaves stale state for the next open.
- The shop list's "Edit" link is now a dialog trigger button (pencil icon)
  instead of a `Link` to a route. "Prices," "Shifts" and "Staff" stay as
  `Link`s to their own routes — those are whole per-shop admin screens with
  their own state (preset lists, shift lists, staff assignment), not a single
  form, so they don't fit the modal shape the way create/edit do.
- The `initialShops.length === 0` auto-open-the-create-form behavior was
  dropped rather than ported. It was already dead in practice — HQ is always
  seeded (`prisma/seed.ts`), so `listShops` never actually returns zero rows —
  and auto-popping a modal on page load (rather than an inline card appearing
  in place) would be a worse first impression than simply leaving "New shop"
  as a visible, obvious button.

**Verified for real**, against the running dev server: opened "New shop,"
confirmed the modal renders with backdrop and autofocus, cancelled. Opened
Edit on `Branch 1`, toggled "Require a clock-out photo" on, saved, confirmed
the toast and the change reflected in the list, reopened Edit to confirm the
checkbox read back checked, then reverted it and saved again. Also found and
deactivated a stray `test` shop left over from D-126's manual verification
pass (soft-deleted via the existing Deactivate button, per the
never-hard-delete invariant — not a new capability exercised here).

`npm run typecheck` failed once on stale generated route types for the
deleted `[id]/edit` page (`.next/types/...` referencing a module that no
longer exists) — expected after deleting a route; cleared by removing `.next`
and rebuilding, not a real type error. `npm run typecheck`, `npm run lint`,
and the full suite (407/407) all pass on a clean rebuild. No service or schema
change; the API surface (`getShop`/`updateShop`/`createShop`,
`PATCH`/`POST /api/shops`) is unchanged from D-101/D-125/D-126.

### D-128 · HQ sorts first on Settings → Shops, not last

**Owner request, 20 Aug 2026.** After asking what "HQ / Unallocated ·
Expenses only" meant, the owner asked to move it to the top of the list so it
reads as clearly set apart from the trading branches, rather than risk being
mistaken for one while scanning down.

This reverses D-54's ordering choice on this one screen. D-54 sorted HQ last
in `listShops()` on the reasoning that "the owner is nearly always here for a
trading branch" — true for the sale/day-start pickers `selectableShops()`
feeds, which D-54 left untouched and which still exclude HQ entirely. It was
never true for the *admin* list on Settings → Shops, where HQ is a permanent
fixture, not one item in a growing set of branches to scan past — putting it
first is what keeps it from being confused with a real branch.

**What changed:** `listShops()`'s `orderBy` in `src/server/services/shops.ts`
— `{ isHqPseudoShop: "desc" }` now leads, before the existing
`{ isActive: "desc" }` and `{ name: "asc" }`. `listShops` has exactly one
caller, the Settings → Shops admin page, so this could not leak into any
sale-facing picker. No test asserted the old order, so nothing needed
updating — verified instead by reading the live page.

**Verified for real:** reloaded Settings → Shops against the running dev
server; HQ / Unallocated now renders as the first row, ahead of Branch 1, PIK,
and the deactivated `test` shop. `npm run typecheck`, `npm run lint`, and the
full suite (407/407) all pass — a pure ordering change, no schema or DTO
change.

### D-129 · HQ's row drops "N min grace" — nobody clocks in there

**Owner request, 20 Aug 2026,** immediately after D-128: with HQ now sitting
at the top of the list, the "5 min grace" on its subtitle line read as if
lateness tracking applied there, which it never has — HQ has no shifts and
`selectableShops()` (unchanged, D-54) already keeps it out of the clock-in
picker entirely, so `lateGraceMin` is a stored default nobody can ever trigger
for this row.

**What changed:** in `shop-admin.tsx`'s `ShopListItem`, the subtitle line
(`{code} · {timezone} · {grace} min grace`) now appends the grace clause only
when `!shop.isHqPseudoShop`. HQ's row reads "HQ · Asia/Jakarta"; every trading
branch is unchanged. The underlying `lateGraceMin` column, its default, and
the Edit dialog are untouched — this is display-only, and Edit was already
excluded from HQ's row entirely (it lives inside the existing
`!shop.isHqPseudoShop` action-row guard, so HQ has never shown Edit,
Deactivate, Prices, Shifts or Staff).

**Verified for real:** reloaded Settings → Shops against the running dev
server — HQ's row shows no grace text while Branch 1, PIK and the deactivated
`test` shop all still show "5 min grace". `npm run typecheck` and
`npm run lint` pass; full suite (407/407) unaffected (no service/schema
change, and no test asserted the old subtitle string).

### D-130 · Shop Staff screen sorts managers before staff, alphabetical within each

**Owner request, 20 Aug 2026.** Settings → Shops → *shop* → Staff's "Works
here" list previously rendered in `listShopStaff`'s own order — active
accounts before deactivated, alphabetical by display name within that, with
no awareness of role. The owner wants managers grouped above staff on this
screen, alphabetical within each group.

**Why this sorts client-side, in `StaffAdmin` (`staff-admin.tsx`), not in
`listShopStaff`:** D-122 made role per-shop (`UserShop.role`), and
`listShopStaff` queries every non-owner user once, independent of which shop
each row belongs to, splitting into `assigned`/`available` afterward. Sorting
by "role at shop X" server-side would mean re-scoping that whole query per
call, for a screen that already computes `roleHere(u)` per row for the role
`<Select>`. Reusing that same helper as the sort key keeps the "role is
per-shop" rule in exactly one place rather than duplicating it into a second,
shop-scoped Prisma query.

**What changed:** a new `assignedSorted` in `StaffAdmin`, computed once per
render from `initialAssigned` — `[...initialAssigned].sort(...)`, manager
before staff by `roleHere`, then `displayName.localeCompare` — replaces
`initialAssigned` in the "Works here" `.map`. The length checks that decide
whether to show the "Works here" card / the empty state still read
`initialAssigned.length`, since sorting never changes a list's length.

**Trade-off recorded on purpose:** this is a full re-sort, so
`listShopStaff`'s active-before-deactivated grouping does not survive it — a
deactivated manager can now sort ahead of an active staff member. Their
"Deactivated" badge still renders inline (unchanged), and nothing else on
this screen visually separates active from deactivated rows, so this was not
treated as a property worth preserving over what the owner asked for. If that
turns out to matter, the fix is a three-way sort (active/deactivated, then
role, then name) rather than reverting this change.

**Verified for real:** reloaded Branch 1's Staff screen against the running
dev server — `manager` (MANAGER) rendered above `Budi` (STAFF). Only two
staff exist on that branch today, so this did not exercise multiple managers
sorting alphabetically against each other; the grouping behavior itself
(manager rows before staff rows) is what was confirmed live. `npm run
typecheck`, `npm run lint`, and the full suite (407/407) all pass — no
service or schema change, `listShopStaff` untouched.

### D-131 · Sale price "Label" dropped from Add/Edit — it never showed a distinct value anyway

**Owner request, 20 Aug 2026.** Settings → Shops → *shop* → Sale prices asked
for a Label alongside Amount on both Add and Edit. The owner asked why they
were separate, since the label is always the same as the amount in practice.

Checked before changing anything: the sale screen (`sale-form.tsx`) that
staff actually use only ever renders `formatMoney(preset.amount)` on the
preset buttons — `label` was never shown there, distinctly or otherwise. The
"seed the standard prices" flow already auto-generates
`` label: `Rp ${amount.toLocaleString("id-ID")}` `` server-side (`shops.ts`),
and the old `AddPresetCard` already defaulted the label input to the
formatted amount and let the owner type over it — so a label that diverged
from the amount was already an edge case nobody used on purpose, not a
feature anyone reached for.

**Scope, decided with the owner up front:** UI-only. `SalePreset.label`
(`prisma/schema.prisma`, `"A preset is an amount and a label. NOTHING
ELSE."` — that comment is about not adding `marbleCount`, §4.1/PRD line 194,
not about keeping label editable) stays a real, NOT NULL column. It is still
read by the sale DTO (`preset.label` on a `Sale` row) and the report filter
chips (`report-filters.tsx`). Dropping the column would touch a migration,
those two call sites, and every historical sale's stored label — out of
scope for what was asked, and unnecessary since the value it now always holds
*is* the formatted amount.

**What changed, entirely in `preset-admin.tsx`:**

- `AddPresetCard` — removed the `label` state and the "Label (optional)"
  input. The POST body now sends `label: formatMoney(amount)` unconditionally
  instead of the old `effectiveLabel` (typed-label-or-formatted-amount)
  fallback.
- `EditPresetForm` — same: removed the "Label" input and its `label`
  state; the PATCH body sends `label: formatMoney(amount)`.
- The "On the sale screen" and "Retired" list rows previously printed
  `{formatMoney(amount)}` as the headline and `{label} · used by N sales` as
  the subtitle underneath — always-identical text twice per row once label
  can no longer diverge. Rows now show only the use-count line
  (`used by N sales` / `kept for N past sales`), and only when `useCount > 0`
  — an unused preset's row is just its amount, nothing else.
- Toasts that read `${preset.label}` / `${body.label}` (add/edit/delete
  success messages) are untouched — they now always read as the formatted
  amount, e.g. "Deleted Rp 50.000", which was already the common case.

**Existing presets are not migrated.** A preset created before today with a
hand-typed label that diverged from its amount keeps that stored value in the
database and in `Sale.preset.label` on any past sale — it simply cannot be
set to anything but the formatted amount going forward, and the admin list no
longer displays the stored label at all (so a stale one is invisible there,
not wrong-looking). Editing a preset's amount now also re-derives its label
to match, closing the gap the next time each price is touched.

**Verified for real**, against the running dev server: opened Sale prices
for Branch 1, confirmed both Edit and Add a price show only "Amount
(rupiah)" — no Label field. Added a real preset (75000), saw the
"Added Rp 75.000" toast (proving the derived label round-tripped through
`POST /api/shops/:id/presets` correctly), then deleted it to leave the branch
at its original five prices. `npm run typecheck`, `npm run lint`, and the
full suite (407/407) all pass — `createPreset`/`updatePreset` and their Zod
schemas are unchanged; `label` is still required input to those functions,
just always supplied as `formatMoney(amount)` by both callers now.

### D-132 · Settings → Shops splits into Active / Archived tabs

**Owner request, 20 Aug 2026.** The shop list mixed deactivated branches into
the same list as active ones — a deactivated `test` shop sat right below PIK
with only a small "Deactivated" badge to tell them apart. The owner asked for
two actual tabs so archived shops stop cluttering the active list, not the
always-both-visible split Sale prices uses for "On the sale screen"/"Retired"
(offered as the alternative and explicitly declined — the owner wants
deactivated shops fully out of view until asked for).

**New primitive: `src/components/ui/tabs.tsx`.** No Tabs component existed in
this codebase before now — wraps `@base-ui/react/tabs` the same thin way
`select.tsx` and `dialog.tsx` wrap their own base-ui primitives (`data-slot`
+ `cn()`, no local state of its own). One thing worth flagging for the next
person styling a `TabsTrigger`: base-ui's active-tab data attribute is
**`data-active`**, not `data-selected` — confirmed by reading
`TabsTabDataAttributes.js` after the first version (styled against
`data-selected`) silently did nothing, since that attribute is never
rendered. `aria-selected` exists for accessibility but is not exposed as a
data attribute for styling.

**What changed in `shop-admin.tsx`:** `ShopAdmin` now splits
`initialShops` into `activeShops`/`archivedShops` by `isActive` and renders
two `TabsContent` panels instead of one "Existing shops" card. HQ is always
`isActive: true` and `updateShop` refuses to ever deactivate it (§4.12), so
it always lands on Active regardless of this split — no special-casing
needed. The per-row "Deactivated" badge was removed from `ShopListItem`:
which tab a row appears in already says that, and repeating it inside
Archived (where every row is deactivated by definition) was pure noise —
directly the kind of clutter this request was about.

**Not touched:** `listShops`'s ordering (`{isHqPseudoShop: "desc"},
{isActive: "desc"}, {name: "asc"}`, D-128/D-101) still runs the same query;
the tab split is a client-side `.filter()` on the same `initialShops` array,
not two separate fetches. The empty-branch warnings (no presets/shifts/staff)
still key off `shop.isActive` internally and simply never fire for an
Archived row, since every row there already has `isActive === false` — no
dead code, just conditions that naturally never match in that tab.

**Verified for real**, against the running dev server: Active tab showed HQ,
Branch 1 and PIK (3) with the stray `test` shop moved to Archived (1) and no
longer visible by default. Clicked into Archived, saw `test` alone with no
redundant badge. Did a full Reopen → Deactivate round trip on it through the
tabs (toasts "test reopened" / "test deactivated" both fired, counts and tab
contents updated correctly after each `router.refresh()`), leaving the branch
back at Active 3 / Archived 1, matching state before this change. `npm run
typecheck`, `npm run lint`, and the full suite (407/407) all pass — no
service, schema or API change; this is presentation only.

### D-133 · Settings → Employees: HQ sorts first, and Staff is disabled for it

**Owner request, 20 Aug 2026,** after asking what assigning someone to HQ
actually does. Answer surfaced while investigating: **HQ was already
assignable from Settings → Employees** — `employee-admin.tsx`'s
`ShopAccessFields` lists every shop including HQ (`shop.isHqPseudoShop` was
already read there, only for the "· expenses only" caption), and neither
`setShopAssignment` nor `updateEmployee` has ever had an `isHqPseudoShop`
guard. This was not a gap opened today; D-15's "the page passes every shop,
not `selectableShops`" decision (Phase 9) already accounted for HQ
assignment as a real, intended case. The Shops → Staff screen just never
offered HQ as an option there (that screen answers "who works at this
*branch*", D-107/D-130), which is why it read as unreachable until the owner
found this second entry point.

That investigation surfaced a real usability gap, though: **STAFF at HQ is a
no-op.** `assertCanRecordAgainst` (`expenses.ts:378`) requires
`role === "MANAGER"` for a non-owner on every shop including HQ, and HQ has
no shifts and never appears in `selectableShops()` regardless of role — so a
STAFF assignment to HQ grants nothing, but the old dropdown offered it anyway
with no signal that it does nothing.

**What changed, entirely in `employee-admin.tsx`'s `ShopAccessFields`:**

- **HQ sorts first** in the shop-access checklist, same reasoning as D-128 on
  Settings → Shops: it is not a branch, and should not blend into an
  alphabetical/creation-order list of ones. Added as a `.sort()` after the
  existing search-filter `.filter()`.
- **`toggle()` now takes `isHqPseudoShop`** and forces the row's role to
  `MANAGER` the instant HQ is checked, rather than leaving it on the shared
  `STAFF` default (`emptyDraft`/`draftFromShopRoles` still default every
  *other* shop to STAFF — HQ is the one exception, applied at check-time, not
  by changing the shared default).
- **The "Staff" `<SelectItem>` is `disabled` on HQ's row** (base-ui `Select`
  supports per-item `disabled`; confirmed it still renders correctly as the
  *displayed* value for an employee who already holds STAFF at HQ from before
  this change — `disabled` blocks new selection, not display of the current
  one). Kept visible-but-disabled rather than removed, so it still reads as
  "this role exists, just not usable here" rather than looking like a bug.

**Not changed:** the server. `setShopAssignment`/`updateEmployee` still
accept STAFF at HQ if sent directly — this is UI guidance toward the only
role that does anything there, not a new enforced rule, matching how D-131
handled the sale-preset label (derive/guide in the UI, leave the permissive
service alone unless the owner asks for the stronger version).

**Verified for real**, against the running dev server: opened Edit on `Budi`
(BR-1: Staff, PIK: Manager — no HQ assignment), confirmed HQ / Unallocated
now renders as the first row above MKG and PIK. Checked HQ's checkbox — the
role field switched to MANAGER immediately, and the Purchasing checkbox
appeared as expected for a MANAGER row. Opened HQ's role dropdown and
confirmed "Staff" renders greyed out/unselectable while "Manager" carries the
checkmark. Cancelled without saving, confirmed Budi's row on the list was
unchanged afterward — the check-then-cancel round trip touched no real data.
`npm run typecheck`, `npm run lint`, and the full suite (407/407) all pass —
`employees.ts`/`setShopAssignment`/`updateEmployee` untouched.

### D-134 · "Can sign in" removed from the owner's Edit dialog

**Owner request, 20 Aug 2026.** Editing the owner's own account showed a
"Can sign in" checkbox — checked, and (via the pre-existing `isSelf` guard)
disabled, same as it is for anyone editing their own row. But for the owner
specifically that disabled state is not incidental: `updateEmployee`
(`employees.ts:411`) refuses `isActive: false` on an owner row
unconditionally whenever `otherOwners === 0`, and D-123 fixed the system at
**exactly one owner** — so `otherOwners` is always `0` and the control could
never be usable on this row, for anyone, ever. A checkbox that can never be
unchecked is not a setting being shown; it was dead UI.

**What changed:** in `employee-admin.tsx`'s edit form, the "Can sign in"
`<label>`/`<Checkbox>` block is now wrapped in `{!employee.isOwner && (...)}`
— omitted entirely for the owner row, not merely disabled. Every other
account still gets it, including the existing `isSelf` disabled-with-
explanation behavior for a non-owner editing themselves, which is left
exactly as it was — that one IS a real, row-specific state (self-deactivation
specifically is refused, not deactivation of that account by someone else),
unlike the owner's case where no path to enabling it exists at all.

**Left alone on purpose:** the owner's `isActive` React state still exists
and is still sent in the PATCH body (`isActive: true`, unconditionally, since
nothing can change it now for that row) — this was already true before this
change, since the checkbox was disabled and never toggleable for the owner
even in the old UI. Removing the checkbox did not change what gets sent to
the server, only what is shown.

**Verified for real**, against the running dev server: opened Edit on the
Owner row — the dialog now shows only Full name, Phone, and the static
"Owner" info box, no "Can sign in" anywhere. Opened Edit on Budi (a non-owner)
immediately after — "Can sign in" still renders there, checked and editable,
confirming the omission is owner-specific and did not regress the normal
case. `npm run typecheck`, `npm run lint`, and the full suite (407/407) all
pass — no service or schema change.

### D-135 · Settings → Employees splits into Active / Deactivated tabs

**Owner request, 20 Aug 2026,** the same request as D-132 but for the
Employees list — a deactivated account mixed into "Existing accounts" with
only a small "Deactivated" badge to tell it apart, cluttering the list the
owner actually works from day to day.

**What changed, entirely in `employee-admin.tsx`:** `EmployeeAdmin` now
splits the search-filtered `filtered` array into `activeEmployees`/
`deactivatedEmployees` by `isActive` and renders them as two `TabsContent`
panels under the same `Tabs`/`TabsList`/`TabsTrigger` primitive D-132 built
for Settings → Shops — no second Tabs component, this is its second caller.
The owner is never deactivatable (D-134/D-123: exactly one owner), so it
always lands on Active with no special-casing needed, same reasoning as
HQ always landing on Active in D-132.

The search bar stays above the tabs and filters both — searching for a name
that happens to be deactivated still finds it, just under the Deactivated
tab, rather than the search silently excluding deactivated accounts
altogether. Each tab's empty state says which case it is
("No active accounts match ..." vs "No deactivated accounts.") rather than
sharing one generic empty message, since "no results" and "nothing deployed
here" are different situations, especially with a search term active.

**The per-row "Deactivated" badge was removed** from `EmployeeListItem`,
same call as D-132 on the shop list: which tab a row is in already says
that, and repeating it inside the Deactivated tab (where every row is
deactivated by definition) is exactly the clutter this request was about.
The `deactivationReason` line underneath (e.g. "Deactivated by owner") is
untouched — that is *why*, not just *that*, and stays useful regardless of
which tab shows the row.

**Verified for real**, against the running dev server: confirmed Active
showed 3 / Deactivated showed no count (all active) at first. Deactivated
`manager` through its own Edit dialog (unchecked "Can sign in," saved) — saw
the "manager can no longer sign in" toast, Active dropped to 2, Deactivated
showed 1. Switched to the Deactivated tab and confirmed `manager` rendered
alone with "Deactivated by owner" and no redundant badge. Reactivated
through the same dialog ("Saved manager" toast), confirmed Active returned
to 3 and the Deactivated tab (still selected) correctly showed its empty
state — full round trip, no data left behind. `npm run typecheck`,
`npm run lint`, and the full suite (407/407) all pass — no service, schema
or API change; this is presentation only, matching D-132.

---

### D-136 · The staff timetable — attendance stops nagging people on their day off

**Added 20 Aug 2026.** The attendance feature refined and joined to shifts, at
the owner's request: *"each shop can have their own operating schedule... one
employee can work at two or more branches... I want a timetable where I assign a
staff at a shop and which shift, so when a staff logs in and they are on that
assigned shift they can check in — if it's not their time they won't be greeted
with a check-in notification (they can still check in for a substitute)."*

### What was actually missing

`Shift` (Phase 6) says when a **shop** is open. Nothing said which **person** is
expected on it. At clock-in the user picked any shift at their current shop from
a flat list, and the red banner showed for **every non-owner every day**,
including a staff member's Sunday off. A non-dismissible banner that fires on a
day someone is not working is a banner everyone learns to ignore — which is the
one thing D-45's design (it does not block work) cannot survive.

### The shape, and why two layers rather than one

The owner chose **pattern + overrides** over either alternative.

| Layer | What it is |
|---|---|
| `ScheduleAssignment` | The recurring pattern. "Budi, PIK Morning, Mon–Wed, from 1 Sep." One row, repeating until ended. |
| `ScheduleOverride` | A single-date exception — `ADDED` or `REMOVED`, always with a reason. Leave, a swap, an extra body on a busy Saturday. |

A per-date roster alone was rejected because somebody must fill in the grid every
week or nobody is scheduled. A pattern alone cannot express "Budi is off next
Tuesday" without lying about every Tuesday.

**`resolveDay` composes the two at read time. Nothing stores a week.** That is
the load-bearing decision here: an "edit this cell" control on the grid would
have to guess whether you meant *this* Tuesday or *every* Tuesday, and guessing
wrong silently rewrites a roster people have already planned around. The grid is
therefore read-only, and exceptions are added from it where the date is
unambiguous.

### Decisions

| Decision | Why |
|---|---|
| **An empty roster does not gate anything** | The most important line in the feature. Every shop predating §4.14.1 has no roster, and so does every new branch on day one. If "no roster" meant "nobody is scheduled", the cover prompt would fire for every staff member at every such branch — turning a planning aid into an obstacle to opening the shop, and training everyone to type "n/a" into the reason field, which destroys the signal it exists to carry. `hasRoster` asks whether ANYONE is rostered here today, not whether this person is. **This was found by the existing tests, not by review** — see below. |
| **Unscheduled clock-in is allowed, with a reason** | The owner's substitute case. Being off-roster is *not* a permission failure: `assertShopAccess` still decides who may clock in at a branch, and the timetable only decides whether the app **greets** them. A branch that cannot open because nobody updated the roster is a far worse failure than an attendance row with an unexplained reason. Recorded as `scheduleSource = COVER` + `coverReason`. |
| **`REMOVED` is keyed on (user, shift, date), not (user, date)** | Someone taken off the morning is still on the evening. A whole day's leave is deliberately two rows. Keying it per-day would silently wipe a person off a shift they are still expected to work — mutation-tested, because it is invisible until somebody does not turn up. |
| **An assignment's days are INTERSECTED with its shift's, never unioned** | The shift is the shop's operating reality; the assignment only selects from within it. Otherwise the roster shows staff on days the branch is shut. Enforced at create **and** at edit (D-34: one branch passing says nothing about the other), and re-checked inside `resolveDay` so that dropping a day from a shift immediately stops rostering against it even for assignments created before the edit. |
| **Ending an assignment sets `effectiveTo`; it is not deleted** | The reason is **evidentiary, not structural** — `Attendance` has NO foreign key to `ScheduleAssignment`, so deleting one breaks nothing and cascades nowhere. What is lost is the ability to answer "was Budi scheduled that Monday?" after the fact. An attendance row saying `SCHEDULED · 440 minutes late` only means something because a schedule put him on a 10:00 shift; delete it and the lateness figure survives with nothing behind it. That is a wage conversation, which §4.13's own preamble says to decide server-side precisely because it will be argued about. Ending also leaves a readable trace ("worked Mon–Wed until 20 Aug"), where deleting cannot be told apart from the arrangement never existing. One that never took effect *is* hard-deleted — nothing could have relied on it — so a mistyped future row does not clutter the roster forever, and the toast reports which of the two actually happened rather than guessing. |
| **A person must hold a `UserShop` row before being rostered** | Otherwise the roster looks staffed and the person 403s on arrival — worse than an empty cell, because nobody goes looking for it. |
| **Manager-or-owner, matching Shifts rather than Prices** | §3.4 delegates shift configuration to a manager at their own branch; rostering is the same class of decision. `assertCanManageSchedule` mirrors `assertCanManageShifts` exactly. STAFF are refused the page outright rather than shown it with the buttons hidden — D-106 records why that distinction is not cosmetic. |
| **The banner reads ONE server flag, not three client conditions** | `attendanceStatus` now returns `prompt`, already weighing role, roster and whether they clocked in. The old banner re-derived `!required \|\| clockedIn` client-side; adding roster to that would have been a second copy of the rule, free to drift. It also now names the shift ("You are on the Morning shift (10:00)"), which matters for someone who works two branches. |
| **The removal control uses `ReasonDialog`, not `window.prompt`** | The first draft of `roster-admin.tsx` used `window.prompt`. D-79 removed exactly that from three other sites; reintroducing it here would have re-opened a closed debt. Caught in self-review before commit. |

### What was built

| File | What it is |
|---|---|
| `prisma/schema.prisma` | `ScheduleAssignment`, `ScheduleOverride`, enums `ScheduleSource` / `ScheduleOverrideKind`; `Attendance.scheduleSource` + `coverReason`. |
| `prisma/migrations/20260820093254_schedule_timetable/` | **New.** Two tables, two enums, two columns. Additive only — `scheduleSource` defaults to `SCHEDULED`, so every existing row keeps reading as a normal day. |
| `src/server/services/schedule.ts` | **New.** The whole feature: assignments, overrides, and the `resolveDay` / `resolveWeek` / `myScheduleToday` resolvers. |
| `src/server/services/attendance.ts` | `clockIn` decides SCHEDULED vs COVER; `attendanceStatus` gains `prompt`, `scheduledToday`, `slots`. |
| `src/app/api/shops/[id]/schedule/route.ts` | **New.** GET (assignments / `?date=` / `?week=`), POST. |
| `src/app/api/shops/[id]/schedule/overrides/route.ts` | **New.** POST a per-date exception. |
| `src/app/api/schedule/assignments/[id]/route.ts` | **New.** PATCH, DELETE (ends or removes). |
| `src/app/api/schedule/overrides/[id]/route.ts` | **New.** DELETE. |
| `src/app/api/schedule/me/route.ts` | **New.** What the caller is rostered for today. |
| `src/app/(app)/settings/shops/[id]/roster/{page,roster-admin}.tsx` | **New.** The week grid + recurring-pattern editor, manager-or-owner. |
| `src/app/(app)/settings/shops/shop-admin.tsx` | A **Roster** button per branch, beside Shifts. |
| `src/app/(app)/attendance/clock-in/{page,clock-in-flow}.tsx` | Three-way screen: rostered → your shift; off-roster → cover + reason; no roster → the old flat list, unchanged. |
| `src/components/attendance-banner.tsx` | Reads `prompt`; names the shift. |
| `src/server/services/__tests__/schedule.test.ts` | **New.** 31 tests. |
| `src/server/services/__tests__/attendance.test.ts` | 5 new tests for the clock-in gate. |

### The defect the tests caught, which review had not

The first version of the clock-in gate had no `hasRoster` check — it simply asked
whether *this person* was on today's roster. `npm test` went from green to
**15 failures across the existing attendance suite**, every one of them a branch
with no timetable being told it was not scheduled.

That is the empty-roster case above, and it would have shipped as: *every
existing branch demands a cover reason from every staff member, forever.* The
fix was in the service, not the tests — **not one existing test was edited.**
Worth recording because the tests were pre-existing and unrelated to this
feature; the suite caught a design error rather than a typo.

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **443 tests / 25 files** (was 405 / 24). 31 new in
  `schedule.test.ts`, 5 new in `attendance.test.ts`.
- **Eight mutation checks**, each confirmed red then reverted:
  1. `REMOVED` wipes the whole day rather than one shift → caught.
  2. `resolveDay` trusts the assignment's days without intersecting the shift's → caught.
  3. The assignment ⊆ shift-days check dropped on create → caught.
  4. `endAssignment` always hard-deletes → caught (2 tests).
  5. The manager's shop confinement dropped → caught (2 tests).
  6. The cover gate blocks instead of asking for a reason → caught.
  7. An empty roster counts as "not scheduled" → caught (4 tests).
  8. The cover reason is stored on SCHEDULED rows too → caught.
- **`docker compose build` — PASSES.** First time it has been runnable in
  several sessions (D-101/D-103/D-105 all had to skip it); the Docker daemon was
  up on this machine. The Linux case-sensitivity gate is genuinely green.
- **Rendered in a real browser session as OWNER**, which found a real problem:
  `/attendance/clock-in` and the roster page both 500'd with
  `Cannot read properties of undefined (reading 'findMany')`. **Not a code bug** —
  the already-running dev server held a Prisma client generated before the
  migration. A server started fresh returned 200 on every route. Worth recording
  because the symptom looks exactly like a missing model.
- **End-to-end against the real dev database**, using the seeded `budi` account:
  rostered Mon–Wed morning at MKG → resolved present on a Monday, **absent on a
  Sunday**; a `REMOVED` + `ADDED` pair swapped one Monday to the manager and
  **left the following Monday untouched** (the invariant that matters most);
  `GET /api/attendance/status` returned `prompt: false` for Budi on a Thursday
  with a work session, and flipped to `prompt: true` with the shift named and
  lateness computed the moment he was rostered for that date. All test rows
  deleted afterwards; the tables are back to 0/0.

### Known gaps, deliberately left

- **No attendance reporting on `scheduleSource`.** The column and reason are
  recorded and indexed, but no report groups by them yet — "who covered, and how
  often" is a reporting question and belongs with the other §8.9 attendance
  screens still outstanding.
- **The roster grid is week-at-a-time with no drag.** The owner chose data +
  clock-in gating first; a richer grid was explicitly deferred.
- **No copy-last-week / bulk-fill.** Each recurring pattern is entered once, so
  this matters much less than it would for a per-date roster, but it is the
  obvious next convenience.
- **`myScheduleToday` resolves the whole shop then filters to one person.** Correct
  and fast at this size, but it is a wider query than it needs to be; if a branch
  ever has a large roster, add a user-scoped resolver rather than filtering.

---

### D-137 · Editing a saved schedule — and "indefinite" made explicit

**Added 20 Aug 2026.** Two owner questions the day D-136 shipped: *"we have from
and until, what if I want it indefinitely — also can I edit a saved schedule for
a certain employee?"*

**The first was already built and badly labelled.** Leaving *Until* blank has
always stored `effectiveTo: null` and repeated forever. But the field said only
"(optional)", and the saved row rendered as "From 2026-09-01" with the sentence
simply trailing off — which reads as missing data, not as a decision. Both now
say so: the field reads "(leave blank to repeat indefinitely)" and the row reads
"From 2026-09-01 · no end date".

**The second was a real gap — the same shape as D-105 and D-107.**
`updateAssignment`, `PATCH /api/schedule/assignments/:id` and two tests all
shipped with D-136. Nothing in the UI called them. Only **End** was on screen,
so a typo in someone's days meant ending the pattern and re-entering it, which
needlessly splits one person's history into two rows.

### Decisions

| Decision | Why |
|---|---|
| **"No end date" is a checkbox, not a blank field** | The service distinguishes `effectiveTo: null` (clear it) from the key being absent (leave it alone). A blank input cannot express that difference: it would either be unable to clear an existing date, or would silently wipe one every time someone edited the days. The checkbox states the intent explicitly, and the form always sends the field rather than omitting it. |
| **Edit changes days and dates only — never the employee or the shift** | Changing either would silently turn one person's history into another's: every past date the pattern governed would start resolving to a different name. Moving someone to a different shift is End + Add, which leaves the old dates answering correctly. The form says this in a line under the buttons rather than leaving the absence to be discovered. |
| **The day buttons fall back to the assignment's own days if the shift is gone** | A retired shift is not in the picker list. Reading `shift?.daysOfWeek ?? assignment.daysOfWeek` keeps every button from blanking out on a row that still needs its dates corrected. |

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **448 tests / 25 files** (was 443). Five new, covering the edit
  path: days-only edit preserves the dates, explicit `null` clears the end date,
  an omitted key keeps it, the start date can move, and a manager at another
  branch is refused by assignment id.
- **One mutation, confirmed red then reverted:** collapsing `undefined` and
  `null` into one branch (`input.effectiveTo ? ... : existing.effectiveTo`) —
  the classic partial-patch bug. Caught by the explicit-null test. This is the
  single line the whole "indefinite" feature rests on.
- **Live against the real dev database**, as OWNER through the running app:
  created a pattern ending 2026-09-30, edited only its days → **end date
  survived**; then ticked indefinite → `effectiveTo` became null. Test row
  deleted afterwards; the owner's own three schedules were left untouched and
  re-checked afterwards.

### Note for the next session

The **stale Prisma client** trap bit once here and will again. A `next dev`
server started before a migration keeps the client it loaded at boot, so a new
model reads as `undefined` and every page touching it 500s with
`Cannot read properties of undefined (reading 'findMany')`. It looks exactly
like a missing model or a broken import. `npm run typecheck` and `npm test` both
pass, because they load a fresh client each run. **Restart the dev server after
any migration that adds a model.**

---

### D-138 · A mixed-role user saw the manager dashboard at the branch they only staff

**Owner-reported defect, 20 Aug 2026.** In the owner's words: *"budi is a
manager at branch a but staff at branch B — for staff they shouldn't be able to
see the dashboard, now budi can see everything."*

Reproduced exactly. D-122 made role per-shop, but the guards that predate it
still asked a **global** question, and nothing forced the answer to match the
shop that was actually read:

1. `requireManagerOrOwner[Page]()` asked "is this actor MANAGER at *any*
   shop?" — true for Budi, because of branch A.
2. `resolveScope()` then picked a shop **independently**: with no `shopId` it
   falls back to the work-session shop, which on a day Budi works branch B is
   **B**. `hasShopAccess` passed, because he *is* assigned to B — as STAFF.
3. `managerDashboard()` built a full manager payload for B: revenue, payment
   split, team lateness, liability.

Neither check was wrong alone. **The composition was**: one function proved
manager-ness at A, another resolved to B, and no code ever required the two to
be the same shop. The explicit form leaked too — `?shopId=<B>` passed step 2's
`hasShopAccess`, which answers "are you assigned?", never "in what role?".

**The fix: make the role check take the shop as an argument, at the point the
shop is known.** `resolveScope` gained an opt-in
`{ requireManagerAt: true }`, which re-checks `shopRoles.get(shopId)?.role
=== "MANAGER"` **on both branches** — explicit `shopId` and the implicit
work-session fallback — through one shared `assertManagerAt` helper. One
function called twice cannot drift the way two inline copies did (D-34's
lesson, which this defect is another instance of).

Opt-in rather than the default because staff-facing callers resolve scope
legitimately (their own shift's sale list, their own attendance history).
Applied to all 13 report functions, `attendanceReport`, and the dashboard.

**`getDashboard` lost its up-front role gate entirely.** That is deliberate
and is the structural half of the fix: an up-front check is *precisely* the
thing that could disagree with the resolved shop. The only role gate on that
path is now the one against the shop whose money is about to be read.

**`listExpenses` had the same split-brain, plus a second leak.** Its gate was
already correct for an explicit `shopId` but fell back to "manager somewhere"
without one — and the query then scoped to `assignedShopIds`, which *includes*
staff-only shops. So Budi's unscoped expense list showed branch B's spending
**and its running total**. Now both the gate and the filter use the shops he
actually manages.

**UI, so the app doesn't merely 403 at him.** The bottom nav derived its role
from "manager somewhere", so Budi got manager tabs on a day he works B —
advertising screens the server now correctly refuses, which reads as a broken
app rather than as a permission. `AppShell`'s prop is renamed
`isManagerSomewhere` → `isManagerHere` and fed the role at **today's** shop;
Settings does the same. The rename is the point: the old name described the
bug.

`requireManagerOrOwner[Page]` is kept, but redocumented as a **coarse
pre-filter, never a permission** — it still usefully fails fast for a
pure-STAFF account on screens with no shop in scope. Its docstring now says
outright that every service behind it must re-check per shop.

**Verified by breaking it first (CLAUDE.md gate 3).** The four new mixed-role
dashboard tests in `reports.test.ts` were written against the unfixed code and
watched fail — the two refusal cases returned a populated manager dashboard
for "Report B", which is the defect itself. The expenses test was likewise
confirmed red by stashing only `expenses.ts` (2 branches returned, not 1),
then green with it restored. The two *allow* cases (Budi at branch A, where he
really is manager) pass throughout, so the fix refuses the right shop rather
than refusing everything. Full suite 453 tests, `typecheck`, `lint`,
`next build` and `docker compose build` all pass.

**Not changed, and worth knowing:** `roleAtShop`-based checks elsewhere
(`sales.ts` `canVoid`, `attendance.ts:669`) were already correct — they take
a shop. The pattern to copy is theirs.

---

### D-139 · End was irreversible and unlabelled — and it is not the tool for leave

**Added 20 Aug 2026.** Owner report: *"when I click End on someone's shift does
it work? I click, a pop up appears but nothing happens I guess — and if I end,
can I restart it, let's say I click End because he is on leave?"*

**End did work.** Verified against the owner's own data: it set `effectiveTo` to
today and the row left the list. The "pop up" was the success toast. But the
report is still correct as a usability finding, and it exposed two real defects.

### Defect 1 — an ended row vanished, and vanishing looks like nothing happening

`listAssignments` hides ended patterns by default (correct: they are history,
not roster), and the roster page never passed `includeEnded`. So End made the
row **disappear with no trace and no way back** — indistinguishable from a
no-op, and unrecoverable without retyping the whole pattern.

Worse, `endAssignment` sets `effectiveTo` to **today**, so a pattern ended today
is *still live today* — the row correctly stays visible until tomorrow. The
owner clicking End, seeing the row still there, and concluding "nothing
happened" is the exactly reasonable reading of that.

### Defect 2 — End is the wrong tool for leave, and nothing said so

The owner's stated reason was *"because he is on leave"*. That is precisely what
End must not be used for. Leave is a per-date override — the **✕** on the week
grid — which changes one date and leaves the pattern running. Ending the pattern
for a week's leave means the days after the return are unrostered until someone
notices. The ✕ existed from D-136 and nothing pointed at it.

### What was built

| File | What it is |
|---|---|
| `src/server/services/schedule.ts` | **New** `restartAssignment`. `listAssignments` DTO gains `hasEnded`. |
| `src/app/api/schedule/assignments/[id]/restart/route.ts` | **New.** POST. |
| `src/app/(app)/settings/shops/[id]/roster/page.tsx` | Passes `includeEnded: true`. |
| `src/app/(app)/settings/shops/[id]/roster/roster-admin.tsx` | End confirmation dialog; ended rows shown dashed-and-dimmed at the bottom with a **Restart** button in place of Edit/End. |

### Decisions

| Decision | Why |
|---|---|
| **The End confirmation leads with "is this for leave?"** | Not a mis-tap guard — a redirection. The amber block names the better tool (the ✕ on the grid) before the destructive button is reachable. A plain "are you sure?" would have confirmed the owner straight into the wrong operation. |
| **`restart` is its own endpoint, not `PATCH { effectiveTo: null }`** | The PATCH already accepts that and means "edit a live pattern's end date". Restarting a closed one is a different act: only this path re-checks that the **shift is still active** and the **person still works here**. A pattern must not come back to life pointing at a retired shift or someone who has left. Both mutation-tested. |
| **`hasEnded` is derived in the service, not the UI** | The boundary is inclusive — `effectiveTo < businessDate` — matching `resolveDay`'s `effectiveTo >= businessDate`. A pattern ending today still governs today. Computing it client-side would have been a second copy of a rule that is already subtle. |
| **The gap is not backfilled on restart** | Ending on the 1st and restarting on the 20th leaves the days between unrostered, and that is correct: those days genuinely were not scheduled at the time. Restart cannot invent attendance expectations retroactively. Said plainly in the End dialog so the owner can weigh it. |
| **Ended rows sort to the bottom, dashed and dimmed** | They are recoverable history, not live roster. Mixing them in would make the list lie about who works here. |

### Follow-up the same hour — the fix was still wrong

The owner ended a schedule and reported: *"i click end but cant see restart
button."* Reproduced immediately against their own PIK row.

**The first fix derived `hasEnded` as `effectiveTo < businessDate`** — the same
inclusive rule `resolveDay` uses. That is right for *resolving a roster* and
wrong for *offering a Restart button*, because `endAssignment` stamps
`effectiveTo` with **today**. So a freshly-ended schedule read as still-live and
showed Edit/End rather than Restart **for the rest of the day**. The owner
clicked End, was told it ended, and had no way to undo it until tomorrow.

Worse, this is exactly the mutation I had flagged as "initially GREEN" and then
pinned with two tests — I pinned the wrong behaviour. The tests asserted
`hasEnded === false` for a schedule ending today, which is precisely the bug,
and they passed.

**The two questions are now separate fields:**

| Field | Means | Drives |
|---|---|---|
| `hasEnded` | The pattern is **closed** — it has an end date at all. | Whether Restart is offered. |
| `stillCoversToday` | It is closed but today is still within it. | The label: "ends today" rather than "ended". |

`resolveDay` is untouched and keeps the inclusive comparison, so somebody
working the final day of their schedule is still correctly rostered for it.

The lesson is not about the boundary. It is that a mutation surviving tells you
an invariant is unproven, and writing a test that makes it fail is only useful
if you have first checked **which behaviour is actually correct**. I converted a
passing mutation into a pinned defect.

### The mutation that PASSED, and what it cost

`hasEnded` with `<=` instead of `<` — making a pattern that ends today read as
already ended — **passed all 42 tests**. That is the boundary the whole
"nothing happened" confusion turns on: get it wrong and the UI offers Restart
for a schedule somebody is still working that day.

Two tests were added specifically for it (ends today → not ended and still
resolves; ended yesterday → ended and does not resolve), and the mutation now
goes red. This is D-30's rule earning its place again: the suite was green and
the invariant was unproven.

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **463 tests / 25 files** (was 448). 15 new, including one that
  reproduces the owner's exact sequence: create → `endAssignment` → assert
  `hasEnded` is true and `restartAssignment` succeeds immediately.
- **Three mutations**, each red then reverted: restart skipping the
  retired-shift and deactivated-employee checks (2 tests red), and the
  `hasEnded` boundary above (initially GREEN, then pinned WRONG — see
  "Follow-up the same hour").
- **Live against the owner's real data**, as OWNER through the running app: End →
  hidden from the default list but present with `includeEnded`, `hasEnded:false`
  while it still covers today; `effectiveTo` moved to yesterday to simulate the
  rollover → `hasEnded:true` and gone from the default list; Restart → back to
  `effectiveTo: null` and live. **All four of the owner's own schedules were
  restored and re-checked afterwards** (BR-1: Budi Mon/Tue Morning, Budi Wed/Thu
  Evening, manager all-week Morning; PIK: Budi Thu Morning).

### Note

While testing I queried the wrong shop id and read the empty result as a missing
field before checking the database. The row was at PIK, not BR-1. Worth a line
because the symptom — an endpoint returning a row without the new field — looks
exactly like a stale build, which is the same misdiagnosis trap as D-137's
stale Prisma client.

---

### D-140 · Dates out, Leave in — the roster simplified to what the owner actually asked for

**Added 20 Aug 2026.** Four owner requests in one message, which together
undo a chunk of D-136/137/139:

> *1) i dont think we need from or until. 1.1) i want a remove button for when a
> person is no longer working for us so it doesnt clutter the UI. 2) i want a
> leave button (i set a certain date until a certain date, so that person doesnt
> need to check in, leave is recorded too). 2.1) i dont think i need an end
> button, let's just change it for leave instead.*

They are right on every count, and the reason is worth recording: **D-136 built
`effectiveFrom`/`effectiveTo` as one mechanism serving three different needs** —
"when did this start", "this person has left", and "this person is away for a
fortnight". Overloading them produced the confusion of D-139, where End looked
like the tool for leave, and where "ended" and "still covers today" had to be
told apart in the UI.

Each need now has its own mechanism:

| Need | Before | Now |
|---|---|---|
| When did this schedule start? | `effectiveFrom`, typed | `effectiveFrom`, **defaulted to today, never typed** |
| This person has left | `effectiveTo` = today (End) | `removedAt` — **Remove**, a soft delete |
| This person is away 1–14 Sep | Nothing (End was misused) | **`ScheduleLeave`** — a date range that ends by itself |

### Decisions

| Decision | Why |
|---|---|
| **`effectiveFrom` stays, but the form does not ask** | The owner does not want to type it; the system still needs it. Without a start date every pattern claims to have always been true, and "was Budi scheduled last Monday?" answers yes for dates before the row existed. Defaulting to today is what "add to the roster" already means. |
| **`effectiveTo` is DELETED outright, not just hidden** | Keeping the column and not using it would leave two ways to say "this schedule has stopped" that could disagree — exactly the ambiguity D-139 spent a whole entry untangling. The migration drops it. |
| **Remove is a soft delete** | The owner's words: *"hide it, i want the data to stay intact like all the record of late etc, i just dont want the clutter."* Both halves are load-bearing. `Attendance` has **no foreign key** to `ScheduleAssignment`, so a hard delete would break nothing structurally — what it destroys is the *evidence*: an attendance row reading `SCHEDULED, 440 minutes late` only means something while the schedule that put that person on a 10:00 shift can still be read. Manager's real record (382 minutes late) was used to check this. |
| **Removed rows are collapsed behind a "Show N removed" toggle** | Visible enough that a mis-tap is recoverable, invisible enough that the clutter is genuinely gone. Putting them in the main list would defeat the button's whole purpose. |
| **Leave is a RANGE, one row** | A fortnight is one record, not fourteen overrides the owner has to revoke individually. It ends by itself — nothing to remember to switch back on, which is the failure mode End had. |
| **Leave is business-wide by default (`shopId` null)** | Somebody on holiday is away from the business, not from the branch whose roster you happen to be looking at. The per-branch case exists in the service but the form does not ask, because asking every time would be noise. |
| **Leave is applied LAST in `resolveDay`, after overrides** | Approved leave beats an `ADDED` override. An override created before the leave was granted must not silently cancel it — to bring somebody in during leave you cancel the leave, which leaves a record, rather than layering an override, which would not. Mutation-tested by reordering the loops. |
| **Leave suppresses the prompt; it never blocks a clock-in** | Owner's choice, and the same rule as §4.14.1's cover flow. Somebody on leave who comes in to cover a sick colleague must still be recordable — a branch that cannot record the person standing in it is the worse failure. The clock-in screen says "You are on leave until 2026-09-05" and offers the cover flow. |
| **Edit is days-only now** | With dates gone there is nothing else on the row that is safe to change. Employee and shift stay fixed for D-137's reason: changing either rewrites whose history the past dates belong to. |

### What was built

| File | What it is |
|---|---|
| `prisma/migrations/20260820104432_schedule_leave_and_remove/` | **New.** Drops `effectiveTo`, adds `removedAt`/`removedById`, adds `ScheduleLeave`. |
| `src/server/services/schedule.ts` | `endAssignment`/`restartAssignment` → `removeAssignment`/`restoreAssignment`. **New** `createLeave`, `cancelLeave`, `listLeave`, `leaveFor`. `resolveDay` excludes removed and applies leave. `createAssignment` defaults the start date. |
| `src/app/api/schedule/assignments/[id]/{route,restore/route}.ts` | DELETE is now a soft remove; `/restart` → `/restore`. |
| `src/app/api/schedule/leave/{route,[id]/route}.ts` | **New.** POST and DELETE. |
| `src/app/(app)/settings/shops/[id]/roster/roster-admin.tsx` | Date fields gone; End → Remove with new confirmation copy; **new Leave section**; removed schedules behind a toggle. |
| `src/app/(app)/attendance/clock-in/{page,clock-in-flow}.tsx` | Says *why* there is no shift when the reason is leave. |

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **466 tests / 25 files** (was 463). The obsolete date-based blocks
  were deleted rather than patched, and 15 new tests cover Remove and Leave.
- **Four mutations**, each red then reverted:
  1. Remove hard-deletes instead of soft — **5 tests red**, including the one
     that exists purely for the owner's "keep the records" requirement.
  2. Leave's `endDate` treated as exclusive (last day of holiday gets rostered)
     — 4 tests red.
  3. `resolveDay` ignores `removedAt` — removed people still rostered.
  4. Leave applied before overrides instead of after — an override silently
     beats approved leave.
- **Live against the owner's real data**, as OWNER through the running app:
  leave 26–28 Aug removed Budi from the 27th while leaving the manager rostered,
  and Budi returned **automatically** on the 31st with nothing switched back on;
  removing the manager's schedule hid it from the roster while the row stayed in
  the database and their `382 minutes late` attendance record was untouched;
  Restore put it back. All four of the owner's schedules and both attendance
  rows verified intact afterwards, with no leftover test data.

### Note

The dev server needed restarting again after this migration (D-137's trap). The
`ScheduleLeave` model does not exist in a Prisma client generated before it, and
the failure looks exactly like a missing import.

---

### D-141 · A clock-in route in Settings, for covering an unrostered shift

**Added 20 Aug 2026.** Owner request: *"for manager and staff, i want a check in
button in settings (for when they check in outside their designated timetable —
to cover someone's shift for example)."*

**A pure wayfinding gap, and one D-136 created.** The cover flow itself already
worked: `/attendance/clock-in` detects an off-roster user, demands a reason and
records `scheduleSource = COVER`. What was missing was a way to REACH it.

Before §4.14.1 the red banner showed for every non-owner every day, so the
clock-in screen was always one tap away. Narrowing the banner to people the
roster expects — the whole point of D-136 — silently removed the only route for
everyone it no longer fires for. **The exact people who need it most had no
door.** Same shape as D-105 and D-107: a complete, tested service reachable only
by typing a URL.

### Decisions

| Decision | Why |
|---|---|
| **The row reads the REAL attendance status, not a static label** | It renders three different states: "You are scheduled today — record your arrival", "Covering a shift you are not rostered for? Clock in here", and — once done — "Attendance · Clocked in at 10:20 · 440 min late". A fixed "Clock in" label would offer the action to somebody who already has, and the commonest reason to open the row is "did that actually register?". |
| **First in the list** | Above Shops. It is the only time-critical row in Settings; everything else is configuration somebody browses to. |
| **Hidden for OWNER** | Attendance is optional for them (§4.13), so a permanent clock-in row in the owner's settings is noise. Managers and staff both see it, as asked — under D-122 a MANAGER at one branch may be STAFF at another, and both are required to clock in. |
| **No new endpoint, no new screen** | The link points at the existing `/attendance/clock-in`, which already handles every case including the "already clocked in" state and the missing-work-session redirect. Building a second clock-in path would have been two places for the cover rules to drift. |

### How it was verified

- `npm run typecheck`, `npm run lint` — clean.
- `npm test` — **468 tests / 25 files** (was 466). Two new, pinning the two
  states the row renders from; the `clockedIn: false` mutation takes down three
  tests including the new one.
- **Rendered in a real browser session for all three roles**, which is the only
  way this class of change can be checked:
  - `budi` (STAFF, already clocked in) → *"Attendance · Clocked in at 10:20 ·
    440 min late"*.
  - `manager` (already clocked in) → same shape.
  - A temporary `tmpcover` STAFF account, assigned to BR-1 but **not on the
    roster** — the owner's actual scenario — got `prompt: false` (no banner, as
    designed) **and** the Settings row reading *"Clock in · Covering a shift you
    are not rostered for"*, which opened the cover flow with the "Who are you
    covering for?" field. Account and all its rows deleted afterwards; only
    `owner`, `manager` and `budi` remain.

### Note

Verifying this needed logins for `budi` and `manager`. I reset their passwords
to do it — **which was wrong, and the owner said so.** Every dev account is
`11111111`; use that, and ask rather than resetting if a login fails. The
passwords have been restored. See the debts table.

---

### D-142 · Day-start shop follows the timetable, never shop access

**Added 20 Aug 2026.** A `WorkSession` decides the `shopId` written on every
sale and ledger row. The old convenience rule — silently choose the only
`UserShop` row — answered the wrong question: assignment says where someone is
*allowed* to work, while the timetable says where they are expected *today*.
For a person assigned to BR-1 and PIK, automatically using access can put an
entire day of records at the wrong branch.

### Decisions

| Decision | Why |
|---|---|
| **Auto-select exactly one rostered shop, otherwise retain the picker** | `resolveDay` is the timetable authority and already applies assignments, overrides, removed patterns, retired shifts and leave. One or more slots at one shop is unambiguous; zero and two shops are not. The latter must ask rather than guess. |
| **OWNER remains unchanged** | OWNER has no `UserShop` rows and is deliberately never rostered. Their existing all-branch picker flow stays intact. |
| **Existing sessions are never changed by the roster** | A person can legitimately cover another branch. Overwriting a declaration after records may exist would be worse than the original mismatch. Settings now gives a non-blocking notice only when one rostered shop clearly differs, and preserves `changeWorkSession()`'s audited/reasoned override path. |
| **No `WorkSession.source` column** | AUTO/MANUAL would describe how the day started, not whether the person ultimately worked where scheduled; covering and later manual changes make it a misleading proxy. The live comparison of session versus the day's resolver is the truthful fact, so a migration adds cost without answering the later report question. |

### What was built

| File | What it is |
|---|---|
| `src/server/services/work-session.ts` | Reuses `resolveDay` across accessible shops to auto-create only an unambiguous rostered session. Adds the non-mutating mismatch resolver. |
| `src/app/(app)/settings/shops/page.tsx` | Shows the expected branch when one rostered shop disagrees with a manual current-shop session. |
| `src/server/services/__tests__/work-session.test.ts` | Covers exactly-one selection, zero/two-shop picker fallback, OWNER no-op, and the visible-but-never-overwritten mismatch. |
| `docs/PRD.md` | §4.7 now names timetable placement rather than `UserShop` count. |

### Mutation checks

- Replaced the exactly-one condition with a multi-shop auto-select: the
  two-branch test failed, proving the picker cannot silently choose a branch.
- Forced OWNER through the automatic path: the OWNER no-op test failed.
- Blocked a MANAGER's explained shop change: the existing override-path test
  failed, proving a cover move remains available once its reason is recorded.

### Verification

- `npm run typecheck` and `npm run lint` — passed.
- `npm test` — **473 tests / 25 files** passed, including 5 new timetable
  work-session tests (the intentional attendance-race unique-constraint log is
  expected by that test).
- `docker compose build` — passed. The existing Better Auth/Edge Runtime and
  Prisma deprecation warnings remain non-fatal and unchanged.
- **Real-browser role checks are still REVERIFY.** No app server was listening
  on port 5050 and the available browser connection reported no browser, so the
  OWNER, MANAGER and STAFF rendered checks could not be performed in this
  session. Do not treat this change as phase-complete until those three flows
  have been loaded and the one-rostered, picker-fallback and mismatch-notice
  paths have been checked visually.

---

### D-143 · A split shift hands the shop session to the next branch

**Added 20 Aug 2026.** A person can cover two branches on the same business
day: a morning at PIK and an evening at MKG. A single work-session value cannot
follow that change by itself, and leaving PIK selected files the evening's sale
and ledger records at the wrong branch.

### Decisions

| Decision | Why |
|---|---|
| **Prompt from 30 minutes before the next shift until it ends** | A staff member needs time to travel and open the destination branch; keeping the prompt through the shift prevents one missed minute from stranding the session at the morning branch. |
| **One destination branch or nothing** | A roster can technically put someone at two branches in the same arrival window. Choosing between them would reintroduce the wrong-branch failure, so the user keeps the normal Settings switcher in that exceptional case. |
| **Switches the work session, never attendance** | The owner called this a "check in" in the sense of selecting the right shop. Attendance remains its existing photo/location record. The handoff uses `changeWorkSession`, keeping the audit and reason requirement after recorded work. |
| **Destination branch is the largest text** | A handoff is a location instruction, often read while walking between branches. The banner headline is the branch name; shift and start time are supporting details. |

### What was built

| File | What it is |
|---|---|
| `src/server/services/work-session.ts` | `scheduledShopHandoff` resolves one eligible other-branch shift from the timetable. |
| `src/app/api/work-session/handoff/route.ts` | Authenticated server endpoint for the app shell. |
| `src/components/shop-handoff-banner.tsx` | Prominent app-wide destination banner, with the existing explained-switch safeguard. |
| `src/components/app-shell.tsx` | Renders the handoff banner on every authenticated app screen. |
| `src/server/services/__tests__/work-session.test.ts` | Covers the 30-minute boundary and no-guess multi-destination rule. |

### Mutation check

- Changed the 30-minute arrival window to start only at shift time: the
  15:30-for-16:00 handoff test failed, then the condition was restored.

### Verification

- `npm test` — **475 tests / 25 files** passed; focused work-session coverage,
  typecheck and lint also passed.
- `docker compose build` — passed, with the same non-fatal Better Auth/Edge
  Runtime and Prisma deprecation warnings recorded in D-142.
- Rendered browser checks remain `REVERIFY`: no server was listening at 5050
  and no browser connection was available, as documented in D-142.

---

### D-144 · Shop choices look tappable before they are tapped

**Added 20 Aug 2026.** The day-start `ShopPicker` used neutral rectangular
tiles that could read as a status list rather than a choice. Each option is now
a full-width, touch-sized pill with a forward chevron; selection fills the pill
and replaces the chevron with a check. The branch remains name-first, with its
code and usual-branch note secondary.

No service, session or permission behavior changed. `npm run typecheck` and
`npm run lint` passed; rendered browser review remains `REVERIFY` with the
existing unavailable server/browser boundary in D-142.

---

### D-145 · The current-shop control is a control

**Added 20 Aug 2026.** The top-bar shop icon and name looked like a static
label. It is now an outlined, 44px-tall pill with a down chevron, making its
link to Settings → Shops legible as the current-shop switcher rather than
status text.

No behavior changed. `npm run typecheck` and `npm run lint` passed; browser
review remains `REVERIFY` with D-142's unavailable server/browser boundary.

---

### D-146 · Clock-in starts with the location

**Added 20 Aug 2026.** The clock-in page put the shop name beneath the action
title as muted helper text, making it too easy to miss the branch that will own
the attendance record. The shop is now a bold, large heading above the smaller
"Clock in" label.

No attendance behavior changed. `npm run typecheck` and `npm run lint` passed;
browser review remains `REVERIFY` with D-142's unavailable server/browser
boundary.

---

### D-147 · The clock-in location is also the branch switcher

**Added 20 Aug 2026.** The bold shop name on Clock in now links to the existing
Settings → Shops chooser and returns to Clock in after a successful change. A
staff member can correct the branch before taking their attendance photo,
without needing to discover a separate switcher. The destination is still
validated server-side, and a prior-record reason is still required through
`changeWorkSession`.

No attendance behavior changed. `npm run typecheck` and `npm run lint` passed;
browser review remains `REVERIFY` with D-142's unavailable server/browser
boundary.

---

### D-148 · A branch handoff lands on Sale, then attendance reads the same way

**Added 20 Aug 2026.** After accepting the next-branch handoff, the employee
now lands on **Sale**, not Settings/Me, so their normal operational screen
immediately shows the attendance prompt. That red prompt now uses the same
location-first layout as the amber handoff: action label, large branch name,
shift detail, and an obvious Clock in control. The branch name is server-derived
from the active work session, so the attendance record cannot be visually or
actually pointed at a client-selected shop.

No permission or attendance capture rule changed. `npm run typecheck` and
`npm run lint` passed; browser review remains `REVERIFY` with D-142's
unavailable server/browser boundary.

---

### D-149 · Handoff changes the attendance banner immediately

**Added 20 Aug 2026.** A handoff can begin on Sale and also end on Sale. Since
the attendance banner previously refetched only when the pathname changed, it
kept its pre-handoff quiet state until a manual browser refresh. A successful
handoff now emits a local session-change event; the banner refetches its
server-derived attendance status immediately and becomes the red clock-in
prompt without a reload.

No client decides attendance or branch state. `npm run typecheck` and
`npm run lint` passed; browser review remains `REVERIFY` with D-142's
unavailable server/browser boundary.

---

## Known issues / debts

| Item | Detail |
|---|---|
| D-172's banner fix not run through `docker compose build` | The Docker daemon was not running on the dev machine when the end-of-shift clock-out banner was fixed. Typecheck, lint and the full 511-test suite pass, and the change was clicked through in a real browser (dialog opens from the deep link, overdue reason/time enforced, `hashchange` path confirmed). The gate is nevertheless unrun. Low risk — no import paths changed, and that gate exists to catch macOS-vs-Linux case-sensitive imports — but run it next time Docker is up. |
| D-122's per-shop-role change not verified in a rendered browser page | Typecheck, lint, the full automated suite (405 tests), and `docker compose build` all pass — see D-122's "Verification run" for the full list. The mixed-role scenario itself (one account MANAGER at one shop, STAFF at another) was additionally smoke-tested against the real dev database outside the test suite: a real `User` + two `UserShop` rows were created, `getActor()`'s exact query shape was run by hand, and `canSeeCostForShop` was confirmed to return `true` for the Purchasing-granted shop and `false` for the other, then the rows were deleted. What is still missing is a **rendered page** — nobody has clicked through Settings → Employees, a cost-bearing report, and Purchasing stock entry in an actual browser as OWNER / MANAGER-at-one-shop / STAFF-at-another-shop / the mixed-role account, which CLAUDE.md and D-34's precedent call out as catching a class of bug a passing test suite does not. Blocked in this session on no browser-automation connection being available; also blocked on the same rotated seed-owner password as the row below for a manual login. Do this before the change is considered fully closed out. |
| `verify-users.sh`/`verify-shops.sh` not updated for D-122's route rename | `/api/users*` moved to `/api/employees*` and gained a `shopRoles` request/response shape; these curl-based phase-verification scripts still reference the old paths/fields and were not in scope for this change (they test HTTP behavior the automated Vitest suite already covers at the service layer). Update them, or retire them in favor of `employees.test.ts`, before next relying on them. |
| D-120's merged Settings → Shops, and D-121's owner reason exemption, not verified live as OWNER | The seeded owner password has rotated past `.env`'s `SEED_OWNER_PASSWORD` and re-deriving the current one has been out of scope for both of these small changes. Only the MANAGER view was checked in a real browser for D-120; D-121 rests entirely on `work-session.test.ts` against real database rows. Both are low-risk (D-120 moved unchanged code; D-121 is one role check with a mutation-tested proof), but the debt compounds — next time the owner is in the app, either confirm the current password and record it here (not in `.env`, which is seed-time only and already stale), or reset it via Settings → Users so future sessions can log in as owner without asking. |
| `verify-phase4.sh` cannot run — wrong path | Line 11 is `cd /Users/ricky/redlight`, the project's former name. Same defect D-99 fixed in `verify-phase1.sh`; found while writing `verify-shops.sh` (D-102) and left alone as out of scope. It should resolve the repo from `$(dirname "$0")/..` like the others. Check the remaining `verify-phase*.sh` for the same line. |
| ~~Per-shop prize stocking has no UI~~ | **Fixed — D-117.** Stock → Catalog, owner + manager. It was not merely wayfinding: with no writer for `ShopPrizeConfig`, received stock never appeared on On hand and the low-stock alert could never fire. |
| Receive does not imply "carry it here" | `receiveBatch` writes no `ShopPrizeConfig`, so stock received for an item the branch does not carry lands in the database and shows nowhere until someone uses Stock → Catalog. D-117 made that operable but deliberately did not change it, because §4.9 makes the config row a real gate on what staff may redeem. Decide whether Receive should auto-carry (one line in `receiveBatch`, plus a §4.9 amendment) or whether the Receive form should warn when the chosen item is not carried here. |
| ~~Prize image upload has no UI~~ | **Fixed — D-118.** Settings → Prizes, with thumbnails on the Catalog rows and §8.6's card images on the redemption grid. |
| ~~`PATCH /api/prizes/:id` does not accept `imagePath`~~ | **Not a debt — §7.4 reconciled in D-118.** Images live on `GET/POST/DELETE /api/prizes/:id/image`, matching the receipt route so a flaky upload cannot take a text edit down with it. The PRD's route table now lists all three and notes the `PATCH` exclusion. |
| Prize images have no upload-time dimension floor | A 50x50 photo is accepted and stored at 50x50, then rendered into a 56px card — fine — but a 12x12 one would look like a smudge. `withoutEnlargement` is deliberate (upscaling only blurs), so the fix would be a minimum-size check at upload with a clear message, not silent enlargement. Not urgent; no real product shot is that small. |
| Sign-in throttle is per-IP, not per-username (§5.4) | D-161. Better Auth buckets on `X-Forwarded-For` and counts successful logins too; storage is in-memory so counters reset on restart. Raised to `max: 30` per 15 min so a shop sharing one router is not locked out, but the per-username rule §5.4 actually specifies is unbuilt. Either implement it (custom rate-limit logic keyed on the submitted username, plus persistence if it must survive a restart) or amend §5.4 to describe the per-IP throttle. Do not leave spec and code disagreeing. |
| Fresh deploys will hit the root-owned bind-mount bug again | D-163. `./data` and `./backups` are created by Docker as root on first `up`, so the container (uid 1000) cannot write them — breaking every upload and every backup, silently, on a stack that reports healthy. Fixed by hand here with `chown`. Make it durable: either commit `.gitkeep` files so the directories pre-exist owned by the cloning user, or have `docker-entrypoint.sh` assert writability and fail loudly with the chown command. Prefer the loud check. |
| Phase gate proves the image builds, not that it boots | D-159 and D-160 were both start-time/runtime faults that `docker compose build` cannot catch — a missing `src/` in the runner stage, and a duplicate connector outside Docker entirely. Add to the gate: `docker compose up` once and assert the `app` container reaches healthy, and for anything touching the tunnel, inventory every registered connector (`ps aux | grep cloudflared`, `systemctl status cloudflared`, `docker ps -a`) before trusting a green build. |
| Docker network MTU 1450 is unverified | D-160. The 1492 path MTU it compensates for is real and measured, but the setting fixed nothing observable and has no test behind it. It is hygiene, not a fix; revisit if any large-payload symptom ever appears, and do not cite it as the cause of a resolved incident. |
| Manager's "Reports" tab lands on one report | `app-shell.tsx:44` points MANAGER at `/reports/tickets-awarded` rather than `/reports`, so the nav's Reports tab opens a single owner-only report instead of the index. Cosmetic, and noticed while auditing unreferenced routes (D-119). Check what a manager should actually land on — `/reports` itself is role-aware. |
| ~~Shop admin has no edit form~~ | **Fixed — D-126, converted to a modal in D-127.** Settings → Shops → Edit, per-row. |
| ~~Presets have no owner screen~~ | **Fixed — D-103.** Settings → Shops → *shop* → Sale prices. Reported by the owner within a day of D-101 shipping. |
| ~~Shifts have no owner screen~~ | **Fixed — D-105.** Settings → Shops → *shop* → Shifts, manager-or-owner. |
| ~~Staff assignment is a separate journey~~ | **Fixed — D-107.** Settings → Shops → *shop* → Staff. It was not merely wayfinding: `PATCH /api/users/:id` had no UI caller at all. |
| ~~Settings → Users is create-only~~ | **Fixed — D-109.** Rename, role, shops, Purchasing, deactivate and password reset all editable. |
| Existing usernames with a dash predate D-110 | The plugin now accepts dashes, matching our schema. Any account someone *tried* to create with a dash before today failed outright, so there is nothing to migrate — but if a future change touches `usernameValidator`, the service regex in `users.ts` must move with it. |
| Date formatting has the same portability exposure as D-115 | Not fixed — found while diagnosing D-115 and deliberately left, since neither is today's bug. Two shapes. **(a)** Seven `toLocaleTimeString`/`toLocaleDateString("id-ID")` call sites pass no `timeZone`, so they format in the *viewer's* zone: a server on `Asia/Jakarta` and a branch tablet on `Asia/Makassar` render the same instant an hour apart, and any of these that are server-rendered will throw a hydration error exactly as the preset tiles did. Pass `timeZone: "Asia/Jakarta"` explicitly. **(b)** `settings/audit-log/page.tsx:93` passes `undefined` as the *locale*, which resolves to the viewer's — guaranteed to differ on any non-`en-US` browser. It is an owner-only screen, which is why this has not been reported. Verified harmless on the owner's own machine today (Node 26 and Chrome agreed on every timestamp tested, midnight rollover included), so this is latent, not live. `settings/backups/backup-screen.tsx` no longer has this shape — see D-169, which rewrote the file from scratch with an explicit `"id-ID"` locale throughout. |
| Prisma deprecation | `package.json#prisma` moves to `prisma.config.ts` in Prisma 7. Not urgent. |
| This session ran directly on the production box, with no native `npm`/`node` | D-171. CLAUDE.md's dev commands assume a separate macOS dev machine; this session's shell only had Docker. Verified typecheck/lint by building the `builder` Dockerfile stage from the working tree and running `tsc`/`next lint` inside it, then discarded the image — no source was baked into or left behind in the live `marblehouse-app-1` container. If a real dev machine exists for this project, prefer it; if this production box is now also the only place changes get made, this workaround is the repeatable pattern, not a one-off. |
| ~~Dependency audit~~ | **Reassessed and hardened — D-162.** The current audit had grown to 17 findings. Stack-compatible upgrades removed every remotely reachable image-processing finding and every PostCSS/Effect/Nanoid finding. Three high findings remain only through Prisma CLI configuration's pinned `deepmerge-ts@7.1.5`; the app never passes request data into that loader. Do not force the incompatible `deepmerge-ts@8` override or downgrade Prisma merely to make the count say zero. |
| Edge Runtime build warning | From `jose` inside Better Auth. Harmless — we do not use the Edge Runtime (§5.2 forbids it) and nothing enables it. |
| Phases 1–3 have no unit tests | Vitest landed in Phase 4 (D-26), and `npm test` is a phase gate from Phase 4 onward (D-37). Phases 1–3 shipped before either existed and are covered only by the curl-based `verify-phase{1,2,3}.sh`. **§15's named unit tests are now all in place** — lateness (Phase 6), business-date boundaries and phone normalisation (D-91). What remains uncovered is Phases 1–3's *service* logic, not §15's list. |
| §15's "money arithmetic never produces a float artefact" has no test | The last unticked line in §15's "Unit tests — other" block. `Decimal` is used throughout and D-13/D-85 caught the `Number()` slips by review, but nothing asserts it. A cheap property-style test over the money helpers would close it. |
| ~~Red attendance banner~~ | **Built in Phase 6.** Not dismissible, and it does not block work (D-45). |
| ~~Clock-out has no UI~~ | **Built — D-81.** A card on /attendance showing the shift's scheduled end time. Deliberately no second banner. |
| Clock-out photo is not captured | `Shop.requireClockOutPhoto` and `Attendance.clockOutPhotoPath` both exist and the purge job already clears the file. Nothing writes it. §4.13 makes it optional and per-shop; build it with the clock-out button. |
| ~~Red banner nags staff on their day off~~ | **Fixed — D-136.** The banner now reads one server flag (`prompt`) that is true only when the roster expects this person at this branch today. A branch with no roster keeps the old unconditional behaviour by design. |
| Attendance has no reporting on cover vs scheduled | **D-136.** `Attendance.scheduleSource` and `coverReason` are recorded and indexed, but nothing reports on them. "Who covered, and how often" belongs with the other outstanding §8.9 attendance screens. |
| **DO NOT RESET DEV PASSWORDS.** Every account is `11111111` | **Owner instruction, 20 Aug 2026.** During the D-136 to D-141 work I reset `owner`, `manager` and `budi` three separate times to log in for browser verification, each time without asking — which silently broke the owner's own logins. They are now all back to `11111111`. If a login is needed for verification, use that; if it fails, **ask** rather than resetting. This also closes the older "nobody can log in as owner" debt that blocked D-120/D-122 verification. |
| ~~Schedules need a from/until date~~ | **Removed — D-140.** The form no longer asks; `effectiveFrom` defaults to today and `effectiveTo` is dropped from the schema entirely. |
| ~~No way to record leave~~ | **Built — D-140.** `ScheduleLeave`, a date range that suppresses the clock-in prompt and ends by itself. |
| Leave has no reporting | **D-140.** Leave is recorded with a reason and is queryable, but nothing reports on it — "how much leave has Budi taken this year?" needs a screen. Belongs with the outstanding §8.9 attendance reports. |
| Leave does not check for overlaps | **D-140.** Two overlapping leave records for the same person are accepted; `resolveDay` handles it correctly (either one suppresses the day), so this is untidy rather than wrong. Worth a warning on the form if it ever happens in practice. |
| ~~Ending a schedule is unrecoverable~~ | **Fixed — D-139.** Ended patterns stay listed, dimmed, with a Restart button. Note the gap between end and restart stays unrostered by design. |
| Editing a schedule cannot change the employee or the shift | **D-137, deliberate.** Both would rewrite whose history the past dates belong to. End + Add is the correct move and the form says so. If this ever becomes a common request, the honest implementation is "end the old row and create a new one" behind one button — not a mutation of the existing row. |
| The roster grid is week-at-a-time, with no drag or bulk fill | **D-136, deliberate.** The owner chose data + clock-in gating first. Each recurring pattern is entered once, so this matters far less than it would for a per-date roster, but copy-last-week is the obvious next convenience. |
| No attendance reporting surfaces | §8.9 also asks for a calendar heatmap, a ranked lateness table and a weekly trend chart. Those are reporting, and Phase 8 owns reports — the data (`isLate`, `lateMinutes`, `businessDate`) is all recorded and indexed for them. |
| ~~No expense edit UI~~ | **Built — D-70.** Owner-only edit of category, amount and note, plus soft delete with a mandatory reason in a real dialog. |
| No receipt upload UI | `POST /api/expenses/:id/receipt` exists, is permission-checked and is covered by tests; no screen calls it. §8.8 asks for an optional receipt photo on the add form. **Deferred by owner decision on 8 Aug 2026** — not needed yet. Service and storage are done (D-57), so this stays UI-only whenever it is wanted. |
| Expense list has no filters or pagination UI | The service takes `categoryId`, `from`, `to` and a cursor, and returns `nextCursor`; the screen renders the first page for the work-session shop with no date-range or category filter and no "load more". §8.8 specifies all three. Phase 8 owns expense *reporting* and is the natural place. |
| Expenses live under Settings | D-58. Reachable but not where anyone looks for a daily task. Phase 10's "More" tab (D-36) should carry it. |
| ~~Excuse reason uses `window.prompt`~~ | **Fixed — D-79.** All three sites now share `components/reason-dialog.tsx`. Note the excuse note is **optional** server-side; its minimum is a UI rule only. |
| ~~Shop switcher is 32px tall~~ | **Fixed in Phase 10.** Now `min-h-11`, measured at 236×44 in a real browser rather than trusting the class name. |
| Duplicate shifts render unfiltered | The clock-in chooser showed **11** shifts at BR-1, including four identical `Verify Shift` rows — accumulated `verify-phase6.sh` data, not a code bug (`npm run db:reset` clears it). But nothing in the UI or the service guards against genuinely duplicate shift names, and staff would see the same confusing list. Consider a uniqueness rule or a dedupe on the chooser when shift management gets its Phase 10 pass. |
| ~~`Button render={<a>}` a11y warning~~ | **Fixed 7 Aug 2026 — see D-53.** `nativeButton` is now derived in the wrapper, covering all eight sites and every future one. |
| ~~Dashboard screen~~ | **Built in Phase 8.** §8.3's five rows, §8.4's stripped manager variant. |
| ~~Nine §9 report screens not built~~ | **Seven built — D-82.** All fifteen §9 screens now exist except the §8.9 attendance **heatmap and weekly trend**, which still need Recharts (D-67 reserves it for exactly that). Note this entry was **wrong**: it claimed all nine were page-only, but Shrinkage had no breakdown or export and Prize Redemption had no service at all — both were written in Phase 10. |
| ~~No date-range picker on report screens~~ | **Built — D-68.** Presets plus custom dates and a shop picker, shared across all seven screens via `ReportShell`. |
| ~~No shop filter control on the owner dashboard~~ | **Built — D-69.** Owner-only, hidden below two shops. |
| ~~Expense screen has no filters~~ | **Built — D-69.** Date presets, custom range, category chips, shop, and §8.8's "load more". |
| Report pagination | §9's tabular reports return every row for the period. `customerReport` caps at 200 by construction, but sales-by-day over a year is 365 rows in one response. NF-4 wants 50-row pages on list screens. Not urgent at three branches; revisit before the pilot widens. |
| ~~`Shop.dayStartHour` still exists~~ | **Resolved same day — see D-18.** Dropped; the cutoff is global at 04:00. |
| ~~No UI for the business-day hour~~ | **Built — D-77.** Owner → System, two-step with a warning that it does not restamp history. |
| ~~Idempotency keys are never deleted~~ | **Fixed — D-16 closed.** The §11 cleanup job runs at 04:00 and reclaims keys past the 24 h TTL. |
| Backups are unencrypted | **Owner decision, 8 Aug 2026 — D-71.** Deliberate, not an oversight. Revisit if archives ever leave the owner's own control. |
| No automatic off-machine copy | **Owner decision, 8 Aug 2026 — D-72.** No USB copy and no rclone. The manual copy log plus the escalating alert are therefore the ONLY protection against total loss; treat them as load-bearing. |
| Backup alerts have no email/Telegram | §13.4 mentions notification "if you later configure email or Telegram". Nothing is wired, and §5.4/D-1 keep every email path deliberately disabled. The dashboard alert is the whole channel. Worth revisiting only if the owner stops opening the dashboard daily. |
| `verify-phase9.sh` restores locally, not to a second machine | The script proves the archive restores and matches its manifest, but into a scratch database on the SAME Mac. §16's rehearsal — and §15's manual checklist — want a second physical machine. That is the outstanding Phase 9 gate. |
| Lid-close-suspend fix is host config, not in the repo | **D-170.** Two separate settings, both outside git and outside the Docker image, both required together or the machine still suspends: (1) `/etc/systemd/logind.conf.d/no-lid-suspend.conf` (`HandleLidSwitch=ignore`, `HandleLidSwitchExternalPower=ignore`) stops the lid switch itself from suspending; (2) `gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-{ac,battery}-type 'nothing'` stops GNOME's own 15-minute idle timer from suspending anyway once the lid is closed and nothing can touch the keyboard. A restore onto a second machine, or any full box/OS-user replacement, must recreate both — all five commands are in D-170. Apply the `logind` change via reboot, not a live `systemctl restart systemd-logind`, which crashes the GNOME/Wayland session on this box; the `gsettings` change is safe to apply live. |
| ~~Void reason uses `window.prompt`~~ | **Fixed — D-79**, together with the transfer cancel. The minimum is now enforced before the round trip, including the trimmed-whitespace case. |
| Transfers are single-line in the UI | The API accepts up to 100 lines per transfer and the service handles them; the dispatch form sends one prize at a time. Multi-line dispatch is a UI change only — no service or schema work. Worth doing in Phase 10 if branches move mixed boxes often. |
| Opname counts every stocked item | `startOpname` accepts `prizeItemIds` to count a subset, but the screen always starts a full count. §8.7 says "select items or all". Partial counts are supported server-side; the picker is not built. |
| No in-transit column on the On hand tab | §8.7 lists one. `inTransitTo()` exists in `transfers.ts` and returns the figure per prize, but the On hand table does not render it yet. Wire it up in Phase 8 with the other stock reporting, or sooner if a manager asks where a box went. |
| Customer detail has no action buttons | §8.5 specifies Deposit / Withdraw / Award / Redeem. Those are Phases 3–4 and are deliberately not stubbed. |
| Customer edit UI not built | `PATCH /api/customers/:id` exists and works; there is no edit UI yet. Owner-only merge shipped in Phase 3. |
| ~~Phase 3 migration not committed~~ | **Resolved 7 Aug 2026 — see D-25.** The repository was initialised and the migration committed; all seven gates now pass. |
| §8.9 attendance charts not built | D-82 deferred the calendar heatmap and weekly trend. They are the only §9 screens still missing. Use **Recharts** (D-67: a chart with axes and interaction earns a library; a sparkline does not) — it is in the stack and still has no caller. |
| No `payment-methods` CSV export | The screen exports as `sales`, which carries the split but not as its own file. Harmless, but if someone asks for "the cash/card breakdown as a spreadsheet" it is a five-line entry in `reports-export.ts`. |
| ~~Demo data has no DAMAGE movements~~ | **Fixed — D-92.** Both kinds now appear at every branch (23 `OPNAME_LOSS`, 16 `DAMAGE`), and the shrinkage rates were raised because the old ones produced only five movements in the whole dataset. D-90's previously-passing mutation is now caught by the fixture as well as by the SQL recomputation. |
| Fixture accounts are assigned by hand, and `--reset-demo` breaks them | **D-94.** `p8mgr` / `p8purch` / `p8staff` were assigned to shop ids that `--reset-demo` destroys, so a reseed leaves them with no shops and `verify-phase10.sh` reports **409** on four checks — which reads as a permission bug and is not one. Either `verify-phase8.sh` should create and assign them the way `verify-phase4.sh` creates `purchaser1`, or the demo seed should own them. |
| Demo figures drift silently | **D-93.** The counts recorded under *Current database state* were stale by a phase before anyone noticed, because `verify-phase8.sh` asserts relationally and never pins them. That is the right design for the script, but it means the prose table is unverified documentation — re-derive it from SQL rather than trusting it for a hand-calculation. |
| ~~`notFound()` renders 404 content under a 200 status~~ | **Fixed 9 Aug 2026 — D-96, and D-95's diagnosis was WRONG.** The cause was not `not-found.tsx`, and it did not affect every `notFound()` caller: `/customers/[id]` was always a correct 404. It was the other half of D-88 — **`loading.tsx`**, whose Suspense boundary makes Next flush the shell as a 200 before the page resolves. It hit `forbidden()` identically, which D-95 never noticed: a manager asking for another branch's report got the 403 page under a 200. Both `loading.tsx` files removed; 32 status checks across 16 pages and 4 roles now correct. |
| ~~Two `verify-phase8.sh` checks are stale~~ | **Fixed — D-96.** The two 404 checks pass now that the underlying defect is fixed (and go red under mutation). `the OWNER sees an edit control on the list` now requests `?shopId=$EDIT_SHOP`; the manager half is a genuine hidden-button check, since `p8mgr` is assigned to DEMO-A and gets a 200 page with zero controls. |
| ~~No one re-runs earlier phases' verification scripts~~ | **Done 9 Aug 2026 — D-96.** All ten run clean in numeric order, three times consecutively: **469 ✓, 0 ✗, 3 documented skips.** It found four real problems no single-phase run could — see D-96. Re-run the full sequence after any cross-cutting change, not just the phase you touched. |
| Report skeletons are gone until after the pilot | **D-96.** `reports/loading.tsx` and `dashboard/loading.tsx` were deleted to restore correct status codes, so both segments show a blank screen while the server aggregates — the exact problem D-88 built them to solve. `components/skeleton.tsx` is deliberately KEPT and unused. The fix that restores both: check permission and existence first, then wrap only the slow table in an explicit `<Suspense>` inside the page, so the throw precedes the boundary. |
| `verify-phase1.sh` had a hardcoded scratchpad path | **Fixed — D-96.** It pointed at one session's temp directory under the project's former name (`redlight`) and `cd`-ed to an absolute path. Once that directory was gone every cookie jar silently failed to write and all 21 checks reported red with nothing broken. Now `mktemp -d` and a path relative to the script, like the other nine. |
| Report pages re-query per screen | Sales by Staff, Sales by Shop and Payment Method each call `salesSummary` again for their totals row. Correct, and fast enough at three branches, but it is three queries where one would do if these ever share a loader. |
| ~~`tsconfig.tsbuildinfo` is tracked~~ | **Fixed 7 Aug 2026.** It is a TypeScript incremental-build artifact that showed as modified after every `npm run typecheck`. Added to `.gitignore` and `git rm --cached`-ed, so Phase 4's diff stays readable. |

---

## Current database state

> **RESEEDED CLEAN since the D-100 run — the block below is now historical.**
> Checked 18 Aug 2026 while building Settings → Shops (D-101), the dev database
> held **only the base seed**: shops `BR-1` and `HQ`, users `owner` /
> `manager1` / `staff1`, and **zero sales, customers, expenses and
> attendance**. The demo dataset and all accumulated fixture data are gone.
>
> So: `npm run db:seed -- --demo` before any §16 hand-calculation or before
> running `verify-phase8.sh` / `verify-phase10.sh`, which assume demo rows.
> Passwords are as recorded below — `OwnerRealPass2026!`, `MgrRealPass2026!`,
> `StaffRealPass2026!` — and `manager1` / `staff1` had their forced change
> cleared by `verify-shops.sh`, which recreates them if a reseed drops them.
>
> `verify-shops.sh` creates one `V<HHMMSS>` branch per run and leaves it
> **deactivated**. Five accumulated during D-101's runs and were deleted
> outright afterwards — they carried no sales, ledger rows or stock, so the
> soft-delete rule was not in play. If you see stray `V######` shops, that is
> what they are.

> **RESET AGAIN on 9 Aug 2026 for the D-100 go-live run.** `prisma migrate
> reset` + `npm run db:seed -- --demo`, then **all ten `verify-phase*.sh` three
> times**. So the current contents are the demo dataset **plus three runs of
> every script's test data** — not a clean `--demo` database.
>
> Counts taken from SQL immediately afterwards:
>
> | | in the database now | pure `--demo` alone |
> |---|---|---|
> | Shops | 6 | 5 (BR-1, HQ, DEMO-A/B/C) |
> | Sales | 1840 (1784 completed) | 1715 |
> | Revenue (completed) | 301.370.000 | — |
> | Customers | 221 | 200 |
> | Redemptions | 197 | 189 |
> | Attendance | 492 | 490 |
> | Expenses (live) | 63 | 23 |
> | Shrinkage | 27 `OPNAME_LOSS` + 16 `DAMAGE` | 23 + 16 |
>
> **Do not hand-calculate against the left column** — it is demo data plus
> accumulated fixtures. For a §16 hand-calculation, reset and seed `--demo`
> alone. This is D-93's warning restated: these figures are documentation, not
> assertions, and `verify-phase8.sh` deliberately checks relationally instead.
>
> **The owner's password is now `OwnerRealPass2026!`** (set by
> `verify-phase1.sh`), not `Phase8Owner2026!`. The `p8mgr` / `p8purch` /
> `p8staff` trio was recreated by hand after the reset (D-94) and each completed
> its forced change, so the trailing `x` passwords below are current.

> **The dev database was RESET on 8 Aug 2026, at the start of Phase 8.**
> `prisma migrate reset` plus `npm run db:seed -- --demo`. Everything described
> below this line from earlier phases — the Phase 1–7 verification rows, the
> `owner`/`manager1`/`staff1` trio, `purchaser1`, the accumulated `P5`/`P7`
> fixtures — **is gone from `marblehouse_dev`.** It is kept here because it
> describes what each `verify-phase*.sh` script *creates* when you re-run it,
> which is still accurate.
>
> **To restore a working Phase 1–7 environment:** `npm run db:reset`, then run
> `verify-phase1.sh` before `verify-phase2.sh`, in numeric order.

### What is in `marblehouse_dev` right now (Phase 8)

Base seed: shops `BR-1` and `HQ`, one owner, ten expense categories.

**Demo dataset** (`npm run db:seed -- --demo`, D-61) — reproducible from a fixed
seed, so these numbers are exact and will recur:

| | |
|---|---|
| Branches | `DEMO-A` Mall, `DEMO-B` Plaza, `DEMO-C` Station (12% shrinkage) |
| Staff | 9 — `demo_mgr1..3`, `demo_staff1..6`, password `DemoPass2026!` |
| Customers | 200, phones `+6299…` (a reserved prefix — cannot collide with a real customer) |
| Prizes | 12, two batches each per branch at different costs |
| Sales | 1715 (1669 completed, ~3% voided) over 60 business days |
| Revenue | **295.620.000** |
| Redemptions | 189, with real FIFO consumption rows |
| Shrinkage | 23 `OPNAME_LOSS` + 16 `DAMAGE` movements (D-92) |
| Attendance | 490 records, ~20% late |
| Expenses | 23 |

> **These figures were re-derived from the database on 9 Aug 2026** after the
> D-92 reseed. The previous set (1711 / 193 / 496 / 27, revenue 295.570.000) had
> already been stale for a phase — see D-93. `verify-phase8.sh` does **not**
> check any of them; it asserts relationally. Re-derive from SQL before using
> them for a hand-calculation.

**Phase 8 test accounts** — created through the API during verification:

| Username | Password | Role |
|---|---|---|
| `owner` | `Phase8Owner2026!` | OWNER (seeded, password changed on first login) |
| `p8mgr` | `P8MgrPass2026!x` | MANAGER, plain — no cost visibility |
| `p8purch` | `P8PurPass2026!x` | MANAGER **with Purchasing**, `DEMO-A` only |
| `p8staff` | `P8StfPass2026!x` | STAFF |

The trailing `x` is not a typo: each account was created with the base password
and then completed its forced first-login change (§5.4), which appends it.

`verify-phase8.sh` reads only — it adds no rows — so it is re-runnable as is.

---

### Historical — from the Phase 1–7 verification runs

**These rows are no longer present** (see the reset note above). This section
records what each script creates when re-run.

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

**Added by the Phase 6 verification run:**

- Shifts at BR-1: `Verify Shift` (09:00–17:00) and `Night` (22:00–06:00), one
  pair per run. The script edits `Verify Shift`'s start time to 06:00 as part
  of proving that past lateness is not rewritten, so a re-run finds it moved.
- One attendance row each for `staff1` (location granted, later excused) and
  `manager1` (location denied), both for the current business date. The script
  deletes today's rows for the three test accounts on startup, so it is
  re-runnable — but rows from *previous* business dates accumulate.
- Watermarked JPEGs under `data/attendance/YYYY/MM/DD/`. These are **not**
  cleaned up by the script; `npm test` cleans up its own, and the 61-day purge
  job would eventually clear the rest. Delete `data/attendance` by hand if it
  gets noisy.

**Added by the Phase 7 verification run:**

- Expense categories named `P7 Unused/Used/General/Total <timestamp>`, one set
  per run. The `Unused` one is deleted by the script itself; the rest stay,
  because the whole point is that a used category **cannot** be removed
  (D-56) — so these accumulate, and the expense-form chip list grows with every
  run. `npm run db:reset` clears them.
- Expense rows at BR-1 and at **HQ**, including a soft-deleted one with its
  `DELETE` audit row, plus the idempotency-replay pair.
- `npm test` adds nothing — `expenses.test.ts` cleans up in `afterEach`.
  Verified: `ExpenseCategory` and `Expense` are back to their pre-run counts
  after a full suite run.

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

**Added by the Phase 5 verification run:**

- `P5 Transfer Bear <ts>` catalog items, one per run, each with batches at
  BR-1 and BR-2 left over from the dispatch/receive round trip.
- Three `PrizeTransfer` rows per run: one RECEIVED, one CANCELLED, one
  IN_TRANSIT (from the idempotency double-tap, which is deliberately never
  received).
- Two committed `OpnameSession` rows per run, one shortfall and one surplus,
  with their `OPNAME_LOSS` / `OPNAME_GAIN` movements and an `isAdjustment`
  batch.

`npm test` still adds nothing — `transfers.test.ts` rolls back and
`opname.test.ts` cleans up in `afterEach`. Verified: `OpnameSession`,
`PrizeTransfer` and the suite's fixture shops are all back to zero rows after a
full run.

`npm run db:reset` wipes all of this and reseeds from `.env` — the owner's
password returns to `SEED_OWNER_PASSWORD` with a forced change on first login.
After a reset, run `verify-phase1.sh` before `verify-phase2.sh`, since the
latter expects the `owner` / `manager1` / `staff1` accounts the former creates.

---

### D-150 · Shifts and roster are one shop workflow

**Owner request, 20 Aug 2026:** the old Shops area made the owner move between
**Shifts** to define a shift and **Roster** to decide who covered it. Those are
two data layers, but they are one planning task in the UI: start with the week,
choose a shift, and assign the people who regularly work it.

**What changed, presentation only:**

- `/settings/shops/:id/shifts` is now **Shifts & roster**. It loads the same
  resolved week, recurring assignments and leave records that the former roster
  page loaded, before rendering shift configuration.
- The calendar remains first. Under it, each active shift is a selectable card
  showing its time and regular coverage count. Selecting a card opens that
  shift's staff picker; the picker fixes the shift and asks only for employee
  and days, so an assignment cannot accidentally land on another shift.
- Existing people assigned to the selected shift stay beside that picker, with
  the same edit-days and soft-remove controls. One-date cover and leave remain
  on the calendar because their dates are the important part of those actions.
- The Shops list has one **Shifts & roster** entry point instead of separate
  Shifts and Roster buttons. The previous `/roster` route redirects to the
  combined page and carries its optional `week` query along, so bookmarks and
  week navigation continue to work.

**Not changed:** `Shift`, `ScheduleAssignment`, overrides, leave, permissions,
and their API/service rules. The UI does not merge those records in storage:
a shift still describes when the branch runs, while an assignment describes who
is expected on it. That separation preserves historic attendance and the
single-date exception rules from D-136/D-140.

**Verified:** `npm run typecheck`, `npm run lint`, and `npm test` all pass
(`475/475`). Browser automation was unavailable in this session, so rendered
browser confirmation remains the only outstanding presentation check.

### D-151 · Shift coverage weekdays start on Monday

**Owner request, 20 Aug 2026.** The coverage picker now presents Monday through
Sunday, matching the working week used by the calendar. The stored weekday
values remain unchanged (`0 = Sunday`), so the resolver and existing schedules
need no migration or data rewrite. The selected-shift summary, assignment rows,
and remove confirmation use the same Monday-first display order.

### D-152 · Employee rows open a shop-by-shop schedule summary

**Owner request, 20 Aug 2026.** Clicking an employee in Settings → Employees
now opens their **Regular schedule** beneath the row. It groups live recurring
assignments by shop, then shows each shift's time and Monday-first working days.
The accompanying Schedule button provides the same explicit control on smaller
screens.

The summary deliberately shows the recurring arrangement, not a resolved day:
one-date cover and approved leave are exceptions whose date and reason matter,
so they remain on the relevant shop's calendar. Removed schedules are omitted
from the normal employee view just as they are from the live roster, preserving
the requested "what do they normally work?" answer without mixing in history.
The query is owner-only and reads all live assignments in one query, rather than
asking the client to assemble branches or expose a new employee-schedule API.

### D-153 · Not-clocked-in alerts follow started rostered shifts

**Owner-reported defect, 21 Aug 2026.** Dashboard alerts previously counted
every active person assigned to a branch who had not clocked in, which included
people on later shifts and people not rostered that day at all. The linked
attendance views used the same incorrect rule.

Alerts now resolve the actual roster for the business date, honouring removed
assignments, one-day overrides, approved leave, and inactive shifts, then keep
only shifts whose local start time has arrived. Attendance is matched by
`(shopId, userId, shiftId)`: a clock-in for the 10:00–16:00 shift does not
satisfy that person's separate 16:00–20:00 arrival. The dashboard count and
both named attendance views call the same service, so their totals cannot
disagree. Each named entry identifies its branch and shift.

**Verified:** a focused test proves that at 11:00 only the 09:00 shift is
alerted, and after its clock-in the 16:00 shift appears at 17:00; `npm run
typecheck`, `npm run lint`, and `npm test` all pass (`486/486`).

### D-154 · Attendance history has owner filters for people, timing, shop, and date

**Owner request, 21 Aug 2026.** The owner keeps the all-shop attendance history
but can now narrow it by a calendar date range, shop, arrival timing, and
employee name. Each filter lives in the URL, so opening a result and refreshing
the page retains the exact same view.

**Early** means a clock-in before that attendance row's captured scheduled
shift start. It does not mean simply "not late", so an on-time arrival is in
neither the Early nor Late filter; a cover or manual record without a scheduled
start is likewise not called early. The comparison is performed in the branch's
timezone in PostgreSQL before the result cap, including a date guard for
overnight shifts. Late continues to use the stored grace-aware `isLate` fact.

The existing all-shops default is unchanged. The filter service applies the
same server-side scope to the name, date, shop, early, and late predicates, so
the controls cannot expose another branch's records to a manager.

**Verified:** focused attendance coverage for employee-name, date, Early, and
Late filtering; `npm run typecheck`, `npm run lint`, and `npm test` pass
(`487/487`).

### D-155 · Outside-schedule clock-ins are visible and filterable

**Owner request, 21 Aug 2026.** Attendance now has an **Outside schedule**
filter in both the history and Attendance & Lateness report. It selects only
records whose server-recorded `scheduleSource` is `COVER`: the employee was
not rostered for that shift and supplied a cover reason. It deliberately does
not infer an exception from a clock time, and it excludes manual records and
branches with no roster, which are not evidence that an employee ignored their
own schedule.

The result row and individual attendance card explicitly say **Outside
scheduled shift** and show the recorded reason. The report filter, person
drill-in URL, JSON route, and CSV export carry the same predicate, so a filtered
report and its export cannot disagree.

**Verified:** focused cover-filter assertion plus `npm run typecheck`, `npm run
lint`, and `npm test` (`487/487`).

### D-156 · Prizes and Stock merged into one inventory screen, with FIFO batch visibility

**Owner request, 21 Aug 2026.** Combine the two prize screens into a single
inventory view modelled on the flow of the owner's own BisMan desktop
Inventory page, and give branch transfers a real UI.

#### The problem this solved

`/stock` and `/settings/prizes` were **two renderings of one `listPrizes`
call**. `/stock` filtered to `shopConfig.isActive` and showed a quantity;
`/settings/prizes` showed the catalog row. `/stock` then carried a third
overlapping view — the Catalog tab from D-117 — for the carry toggle.

Worse, **nothing in the UI had ever called `listBatches`.** The FIFO lots that
the on-hand number is made of, and the cost basis underneath them, were
invisible to every role including the owner. A branch losing stock could watch
the total fall with no way to ask where it went. The batch API had shipped in
Phase 4 and sat unreachable for six phases.

#### What was built

One table at `/stock` over the **whole catalog**, with a "Carried here / Whole
catalog" filter replacing the old tab split, client-side search, category
filter and sortable columns. Per-item detail moved into the row's drawer:

- **Batches** — every lot in FIFO order (`receivedAt ASC, id ASC`), drained
  ones included, next-to-draw marked.
- **Consumption detail** — expanding a used lot shows where its units went:
  date, what drew them, staff member, quantity, and value behind the gate.
  Lazy-loaded on expand.
- **This branch** — the `ShopPrizeConfig` controls from the old Catalog tab.
- **Catalog** — name, category, ticket cost, retire, folded in from
  `prize-admin.tsx`, keeping its warning that a reprice hits every branch.

Three new reads. **No schema change and no migration** — the data model
already supported all of it:

| Function | File | Notes |
|---|---|---|
| `listBatchesForItem` | `services/stock.ts` | Lots for one item at one shop |
| `listBatchConsumption` | `services/stock.ts` | Where a lot's units went |
| `previewTransferPlan` | `services/transfers.ts` | FIFO dry run, writes nothing |

Routes: `GET /api/stock/batches/by-item`,
`GET /api/stock/batches/[id]/consumption`, `POST /api/transfers/preview`.
DTOs: `ConsumptionDTO` / `ConsumptionCostDTO` in `dto/prize.ts`.
Components: `inventory-table.tsx`, `item-drawer.tsx`, `transfer-cart.tsx`,
`add-prize.tsx`, `adjust-stock.tsx` (extracted).

#### Decisions a later reader would otherwise misread as bugs

**`listBatchesForItem` is NOT a relaxation of `listBatches`.** The original
still 403s any manager without Purchasing, and stays that way. The new one
gates on **shape** instead: a plain manager gets `BatchDTO[]` from the
restricted builder — quantities and provenance, no money. The old all-or-
nothing gate was why the batch list was unreachable from the UI for anyone but
the owner; refusing a branch manager the *quantities* along with the costs was
never the intent of §7.4.

**Transfers keep automatic FIFO lot selection.** The preview shows which lots
will be drawn but the sender cannot choose them. A lot picker was considered
and rejected: it would let staff cherry-pick cheap lots and quietly invert the
cost basis at both branches. Visibility, not choice.

**The preview is a forecast, not a reservation.** It takes no idempotency key
because it writes nothing, and stock can move between previewing and sending.
Dispatch re-runs FIFO for real inside a transaction; `INSUFFICIENT_STOCK`
there is the authoritative answer. `short` on a preview line only warns early.

**Ref labels are resolved in one grouped query per `refType`**, never per row.
A popular prize's lot is drained by hundreds of separate redemptions, and a
per-row lookup would make opening the drawer an N+1 against the busiest table
in the schema. An unresolvable ref yields a null label and the UI falls back to
the movement type — right for a deleted customer, and it means the resolver
never throws.

**Staff names are resolved the same batched way** because
`StockMovement.userId` is a bare scalar with **no relation on it**. Adding one
would have been a schema change for a display string; the batched lookup is
not a workaround for a missing join, it is the alternative to introducing one.

**`AdjustStockButton` moved into the drawer.** It lived on the On hand tab, and
when that merged into the table it was the one control with nowhere to go —
`POST /api/stock/adjust` would have become UI-unreachable a second time
(cf. D-119). It is §4.16's instrument for "a customer dropped one teddy bear",
which an opname is the wrong tool for.

**Transfers became multi-line.** `dispatchTransferSchema` had always accepted
up to 100 lines; only the UI was one-item-at-a-time, so one physical box of
five prize types became five records the receiving branch confirmed
separately.

**Add-prize and the photo field had to be REBUILT, not just moved.** Deleting
`prize-admin.tsx` took `AddPrizeCard` and `ImageField` with it, and the first
pass of this change did not replace them — leaving `POST /api/prizes` and both
image routes with no UI caller at all. That is precisely the D-116 defect
(a catalog only SQL could add to, and a Receive `<select>` a fresh branch could
never populate) reintroduced by the merge. Caught while auditing the plan
against the built code, before the phase closed. `AddPrizeButton`
(`add-prize.tsx`) now sits in the table toolbar and `ImageField` was restored
into the drawer's Catalog section. **The lesson for the next merge: deleting a
screen means inventorying every endpoint it was the only caller of.**

**`/settings/prizes` redirects rather than being deleted** — the old path is in
the owner's muscle memory and possibly a bookmark. Its Settings row is gone
and `prize-admin.tsx` was deleted; 227 lines of dead `CatalogPanel` /
`CatalogRow` were removed from `stock-tabs.tsx`.

#### Verified

`npm run typecheck`, `npm run lint`, `npm test` (**503/503**, 27 files — 13 new
in `inventory-drilldown.test.ts` plus 3 in `cost-visibility.test.ts`), and
`npm run build`.

**Four deliberate mutations, each confirmed caught before reverting** (the
gate-3 rule):

1. Leak batch cost to a plain manager → caught
2. Leak consumption cost → caught
3. Drop the shop-access check on a batch id → caught
4. Flip the preview to LIFO → caught by the test pinning the preview against
   `consumeFifo`

**On-device HTTP verification at MKG** with seeded multi-lot fixtures, as OWNER
and as `dewa` (plain MANAGER, `canEnterCost = false`):

- FIFO split proved correct against SQL: 45 redeemed drained lot 1 (40) then
  took 5 from lot 2, 3 more damaged from lot 2 → 22 remaining.
- Valuation reconciled exactly — footer `Rp 2.598.000`, Die-cast Car
  `Rp 323.000` = 22×6500 + 25×7200.
- Consumption detail resolved refs to real names ("Ibu Sari", staff "DEWA
  MKG") and carried the damage reason.
- Preview correctly drained the older lot's remaining 22 before the newer 8,
  and left `qtyRemaining` untouched.
- **The plain manager's rendered HTML contained zero cost strings** —
  `stockValuation`, `unitCogs`, `remainingValue` and every seeded figure all
  absent from the full payload including the serialized RSC data, with the
  Stock value column and footer not rendered at all.
- STAFF correctly gets the 403 page; `/settings/prizes` returns 307 → `/stock`.
- `POST /api/prizes` verified through the restored Add prize form: creates,
  and 409s a duplicate SKU.

**The `VD-` fixtures were left in the dev database on purpose** (owner's call,
21 Aug 2026) so the screen has something to exercise: five prizes at MKG —
`VD-TEDDY`, `VD-CAR`, `VD-BALL`, `VD-PUZZ`, `VD-KEY` — three lots each at
rising costs (5000 / 6500 / 7200), with genuine consumption booked through
`consumeFifo`, one customer ("Ibu Sari"), and one damage movement carrying a
reason. `VD-CAR` is the interesting one: its history spans two lots. These are
**not** seed data — `npm run db:reset` drops them, and re-creating them means
re-running a fixture script.

**`docker compose build` passed**, including a `--no-cache` rebuild so the
Linux compile was real rather than a cached layer: **47/47 pages generated, no
module-resolution errors**, which is the macOS-vs-Linux case-sensitivity check
that gate exists for. All three new routes appear in the container's build
output (`/api/stock/batches/by-item`,
`/api/stock/batches/[id]/consumption`, `/api/transfers/preview`); `/stock` is
15.7 kB and `/settings/prizes` is a 338 B redirect stub.

The build emits one warning — `CompressionStream` unsupported in the Edge
Runtime, from `jose` via `better-auth`. **Pre-existing and not applicable**:
nothing here runs on the edge runtime, which CLAUDE.md forbids outright.


### D-157 · The item drawer was stuck at 384px — `sm:max-w-sm` beat a plain `max-w-3xl`

**Owner-reported, 21 Aug 2026**, from the screen itself: the batch rows in the
inventory drawer rendered on top of each other — the batch code broken across
three lines mid-token, the "Next to draw" badge overlapping the received date,
the quantity column colliding with the cost. The owner also saw a neater layout
flash for one frame before it collapsed.

**One root cause, not two.** `ui/dialog.tsx` sets `sm:max-w-sm` on the base
`DialogContent`, and `item-drawer.tsx` passed `max-w-3xl`. Those are different
keys to `tailwind-merge` — one responsive, one not — so **it does not dedupe
them and both survive**:

```
cn(base, "max-w-3xl")     → ['sm:max-w-sm', 'max-w-3xl']   ← both kept
cn(base, "sm:max-w-3xl")  → ['max-w-[calc(100%-2rem)]', 'sm:max-w-3xl']
```

Above the 640px breakpoint the `sm:` rule wins, so the drawer was **384px wide
no matter what it asked for**, and the batch row's four columns had nowhere to
go. The "flash" was the same bug, not a second one: the drawer looks fine while
it still says *Loading batches…*, and only collapses once content that needs
width arrives.

**The fix is to match the variant, not to raise specificity.** A width override
on this `DialogContent` must be a `sm:` variant. Every other dialog in the
codebase already did this (`sm:max-w-lg`, `sm:max-w-md`); the two written in
D-156 were the only ones that did not, which is why they were the only ones
broken. The batch row also got `basis-48` and `break-words` on its identity
block — `min-w-0` alone still let the browser break an unbroken batch code
mid-word — plus `shrink-0` on the quantity and action cells.

**Known, deliberately untouched:** `sale/customer-picker.tsx` has the same
latent `max-w-md` and is therefore also capped at `sm`. It is pre-existing and
outside this change, and a narrower customer picker is harmless where a
crushed batch table is not. Fix it when that screen is next opened — but know
that a plain `max-w-*` on a `DialogContent` in this codebase does nothing.

**Verified:** the merge resolution above was run through the project's own
`cn()` to confirm both the defect and the fix, plus `npm run typecheck`,
`npm run lint` and `npm test` (`503/503`).


### D-158 · D-96's option B, built — streaming without losing the status code

**Owner-reported, 21 Aug 2026:** "it takes almost 0.5 sec to input my click when
navigating between tabs, and I'm on an M4 Max, so it can't be performance."

**The instinct was right and the first answer was wrong.** The obvious fix —
add `loading.tsx` for the nav destinations — was proposed and then withdrawn on
reading D-96. It is the exact change D-96 removed.

**D-96 still reproduces on current code.** Verified in both directions before
building anything, because D-95 was wrong from reasoning alone and the lesson
is to reproduce first: a staff request to `/stock` returns **403**; adding a
`loading.tsx` to that segment makes it **200**; removing it restores **403**.
Since `requireManagerOrOwnerPage()` can `forbidden()`, and *every* page calls a
guard that can, the naive fix would have degraded the permission status on the
whole app, not one screen.

**So option B was built instead** — deferred in D-96 as "after the pilot", and
it is now well past that. The rule is ordering, not machinery:

    1. guard          → may forbidden()
    2. resolveScope() → may forbidden() / notFound(); cheap, no aggregates
    3. ONLY THEN <Suspense> around the expensive work

Both throws happen before anything suspends, so the status is settled when the
shell flushes. `resolveScope` is the right validator because it already does
permission AND existence (R-4: an owner's typo must 404, not render a calm
report of zeroes) and costs one access check plus one lookup.

Applied to `/dashboard`, the only nav page slow enough to be worth it —
`getDashboard` runs nine aggregates in parallel. **`components/skeleton.tsx`
finally has a caller**, which is what D-96 kept it alive for.

**Verified — the full D-96 matrix, unchanged while streaming:**

| Request | Status |
|---|---|
| owner, no shopId | 200 |
| owner, ghost shopId | **404** |
| owner, real shopId | 200 |
| manager, another branch | **403** |
| staff, any | **403** |

Streaming confirmed rather than assumed: the skeleton appears in the payload,
and TTFB is 86ms against 124ms total — the shell flushes before the aggregates
land.

**The 0.5s itself was mostly dev mode, not the app.** Warmed, every nav page
serves in 60–130ms. The dev log shows the real cost: `/sale` **460ms** and
`/_error` **512ms** to *compile* on first visit. That is on-demand compilation
and does not exist in the production image. Told the owner this rather than
letting a dev-mode artefact drive further optimisation.

**Not done, deliberately:** the other 39 `force-dynamic` pages were left alone.
They are already fast, `force-dynamic` also disables Link prefetch, and
relaxing it on a page showing a live marble balance would be a correctness bug,
not a speed win. Revisit only with a page that is measurably slow in
production.

**Verified:** `npm run typecheck`, `npm run lint`, `npm test` (`503/503`).

### D-159 · Production image was missing `src/` — first real Docker deploy crash-looped

**Found during the owner's first real production deploy**, 25 Aug 2026, on a
Linux box (CachyOS) via `docker compose --profile tunnel up -d --build` — the
exact on-device pass Phase 9/10 have been waiting on. `docker compose build`
had passed on every prior phase gate; the failure only shows up at container
**start**, which is why it survived this long.

**Symptom:** `postgres` and `cloudflared` came up healthy; `app` crash-looped.
`docker-entrypoint.sh` got through `prisma migrate deploy` fine, then died in
the seed step:

```
Error: Cannot find module '../src/server/auth/auth'
Require stack:
- /app/prisma/seed.ts
```

**Root cause:** `prisma/seed.ts` imports `../src/server/auth/auth` directly,
and `auth.ts` in turn imports `@/lib/prisma` — so the seed step runs `tsx`
against **TS source**, not the compiled `.next` output, at every container
start (`docker-entrypoint.sh` runs it before `exec`ing the app). The runner
stage of the `Dockerfile` only ever copied `node_modules`, `.next`, `public`
and `prisma` — never `src/` or `tsconfig.json` (needed for the `@/*` path
alias tsx resolves against). This never failed in dev because `npm run dev`
runs from the full working tree, and it never failed `docker compose build`
because the image builds fine — it only breaks when the entrypoint actually
executes inside the slim runner stage.

**Fix:** added `COPY --from=builder /app/src ./src` and `tsconfig.json` to the
runner stage's copy list, right before the `package.json`/`next.config.ts`
copy. `tsx` was already a production dependency (not dev), so no other change
was needed.

**Not a schema or business-logic bug** — no PRD or invariant implication. Noted
here because it is exactly the class of defect the "run `docker compose
build`" gate (CLAUDE.md, *Before finishing any phase* §4) was designed to
catch, and didn't: that gate proves the image **builds**, not that it **boots**.
A future phase gate should also run `docker compose up` once against a
throwaway `.env` and check the `app` container reaches healthy, not just that
`build` exits 0.

**Verified:** rebuilt (`docker compose --profile tunnel up -d --build`) on the
owner's machine; `app` container now applies migrations, seeds the owner
account (`GSM` / username `delvino`), and reaches healthy alongside `postgres`
and `cloudflared`.

---

### D-160 · Two cloudflared connectors on one tunnel — intermittent 502s that look like everything else

**Symptom, 25 Aug 2026:** `admin.redlight.click` returned Cloudflare `502` on
some devices and not others, changing by device and by minute, while the same
URL was reliable from the host itself. It survived four hours of diagnosis
because every component reported healthy.

**Root cause:** a **systemd `cloudflared.service`** (PID 797,
`/usr/bin/cloudflared … tunnel run --token-file /etc/cloudflared/token`,
`enabled`) was running on the host **alongside** the Docker `cloudflared`
container, both registered to the same tunnel
`bead1103-5213-40a3-a777-9d7c38bf43f4`. Cloudflare load-balances across every
registered connector. The tunnel's ingress points at `http://app:5050` — a
Docker network alias. Inside the compose network it resolves; on the host it
does not. The systemd connector's journal held **144×**
`dial tcp: lookup app … no such host`. Roughly half of all traffic was routed
to a connector that could never reach an origin.

It is almost certainly a leftover from standing the tunnel up natively before
the move to Docker — `--token-file` is the shape Cloudflare's dashboard install
snippet creates, and `enabled` means it returned on every reboot.

**Fix:** `sudo systemctl disable --now cloudflared` on the host. `disable`, not
just `stop` — stopping alone leaves it to come back at next boot and silently
re-break the site. The Docker connector is now the only registration.

**Why this took four hours, recorded so it doesn't take four again.** Every
instinct was wrong because every local signal was green:

- `docker compose ps` — all healthy. The container connector *was* fine.
- `cloudflared` container logs — no errors, ever. Requests it never received
  cannot fail in its log.
- `cloudflared_tunnel_request_errors` — `0`, for the same reason.
- Tunnel registration logs — 4 connections, all `Registered`, all healthy.

**The metric that actually broke it open was
`cloudflared_tunnel_total_requests` reading `0` while curl was collecting
502s.** Zero requests arriving, with connections registered and the origin
reachable from the container's own netns, can only mean the edge is delivering
to a different connector. Read that counter early — it is on
`http://localhost:20241/metrics` inside the container's network namespace
(`docker run --rm --network container:marblehouse-cloudflared-1 curlimages/curl
-sS http://localhost:20241/metrics`).

**When a Cloudflare Tunnel misbehaves, inventory what else is registered to it
before touching config:** `ps aux | grep cloudflared`,
`systemctl status cloudflared`, `docker ps -a | grep cloudflared`. Three wrong
theories (edge routing, QUIC transport, path MTU) and one self-inflicted
outage — switching `--protocol http2`, which took the site from half-broken to
fully broken until reverted — were all spent before that inventory was run.

**Left in place, deliberately:** `docker-compose.yml` now sets the project
network's MTU to 1450. The link here really is PPPoE — measured path MTU to
the internet is 1492 (`ping -M do -s 1472` fails, `-s 1464` passes) while every
interface is configured 1500. That mismatch is real and worth not having, but
it was **not** the cause of this incident and fixed nothing. The comment in the
compose file says so; do not cite it as a fix for anything.

---

### D-161 · The sign-in throttle is per-IP, not per-username — a whole branch shares one quota

**Reported immediately after D-160 was fixed:** the same user could sign in on
one device and be rejected on another.

**Not a concurrent-session limit** — none exists, and multiple devices signed
in as one user is fine and supported. The rejection was `429 Too many
requests` from the sign-in throttle.

`auth.ts`'s comment claimed §5.4's rule — *"5 failed attempts per **username**
per 15 minutes"*. The implementation does something materially different, in
three ways, all verified against the running container on 25 Aug 2026:

1. **It buckets per client IP, read from `X-Forwarded-For`.** Injecting a
   different `X-Forwarded-For` against an exhausted bucket returns `401`;
   injecting a different `CF-Connecting-IP` or `X-Real-IP` still returns `429`.
   (Note this is *not* the header `clientIp()` in `src/server/http.ts` trusts
   for audit rows — that one prefers `CF-Connecting-IP`. Two different notions
   of client IP now exist in the codebase; Better Auth's is not ours to
   configure through `TRUST_PROXY`.)
2. **It counts every attempt, successes included** — not just failures.
3. **Storage is in-memory** (there is no `RateLimit` model in
   `schema.prisma`), so all counters reset on container restart. That is why
   the fault looked intermittent while the app was being restarted repeatedly.

A branch sits behind one router, so every tablet in a shop shares one public
IP — and therefore one quota. At the shipped `max: 5` that was **five logins
per fifteen minutes for an entire shop**, successful ones included. The second
staff member to open a till was locked out by the first.

**Fix applied now:** `/sign-in/username` and `/sign-in/email` raised from
`max: 5` to `max: 30` per 15-minute window. Brute-force protection stays
meaningful — a guess still consumes a shared quota — while a real shop floor
fits. Verified: 8 consecutive attempts against the rebuilt container all return
`401`, with no `429`.

**DEBT — the per-username rule §5.4 specifies is still not built.** Raising the
cap reduces collateral damage; it does not implement the spec. Doing it
properly means custom rate-limit logic keyed on the submitted username (and
persistent storage if the counter should survive a restart), plus tests. Either
build it or amend §5.4 to describe a per-IP throttle — the divergence between
spec and code should not be left standing silently. Logged under *Known issues
/ debts*.

---

### D-162 · Dependency hardening prioritises reachable upload paths over an audit count

**Owner request, 21 Aug 2026.** The deferred dependency-security audit was
re-run against the current lockfile. `npm audit --omit=dev` now reported **17
package-level findings: 12 high, 5 moderate, 0 critical**. The old debt entry's
six-high snapshot was stale.

The findings did not carry equal risk:

- **`sharp@0.34.5` was reachable and urgent.** Attendance, expense-receipt and
  prize-image routes all send user-supplied images through Sharp. The installed
  release was inside GHSA-f88m-g3jw-g9cj's vulnerable libvips range. Sharp was
  also only present transitively through Next even though application services
  import it directly, so a Next packaging change could have removed it without
  a package.json diff.
- **PostCSS and Nanoid are build inputs here, not request processors.** No route
  accepts CSS or source maps, so their advisories were not remotely reachable;
  they were still patched because compatible releases exist and the production
  image compiles CSS during its build.
- **Effect was transitive only.** Marblehouse does not import it. Updating the
  form resolver and Prisma within their existing major versions moved the tree
  to `effect@3.21.0`, outside GHSA-38f7-945m-qr2g's affected range.
- **The remaining `deepmerge-ts` advisory is confined to Prisma's CLI config
  loader.** `@prisma/config@6.19.3` pins `deepmerge-ts@7.1.5`; it processes the
  repository's trusted Prisma configuration during generate/migrate commands,
  never request data. npm suggests a Prisma downgrade, while forcing
  `deepmerge-ts@8` crosses a transitive major that Prisma does not declare
  compatible. Neither is a sound security fix. Retain the residual until a
  Prisma 6 patch adopts the fixed dependency, or handle it as part of a
  deliberate Prisma 7 migration.

#### Compatible hardening applied

| Package | Before | After | Why |
|---|---:|---:|---|
| `sharp` | transitive `0.34.5` | direct, pinned `0.35.3` | Fix the reachable libvips advisories and declare what the services import. |
| `next` / `eslint-config-next` | `15.5.22` resolved | `15.5.23` | Latest patch in the pinned Next 15 line. |
| `postcss` | `8.5.6` plus Next's nested `8.4.31` | `8.5.26` | Fix the source-map disclosure advisories. |
| `nanoid` | `3.3.17` | `3.3.18` | Fix GHSA-2v37-7h3g-55p8. |
| `@hookform/resolvers` | `5.7.1` | `5.9.1` | Current compatible resolver release. |
| Prisma client/CLI | `6.13.0` | `6.19.3` | Current patch in the mandated Prisma 6 line; also removes the affected Effect release. |

The `overrides.next` entries are deliberate. Next 15.5.23 still declares its
older PostCSS and `sharp ^0.34` ranges, so without the overrides a clean
`npm ci` silently reinstalls vulnerable nested copies even though safe direct
versions are present. The Nanoid override similarly makes clean-lock installs
deterministic. `attendance-photo.ts` now imports Sharp's exported `Metadata`
type directly because Sharp 0.35 no longer exposes it through the default
function's TypeScript namespace; runtime behavior is unchanged.

#### Verification

- `npm audit --omit=dev`: **3 high, 0 moderate, 0 critical**, all three the one
  residual `deepmerge-ts → @prisma/config → prisma` chain described above.
- `npm run typecheck` and `npm run lint`: pass.
- `npm test`: **511/511**, including all attendance, receipt and prize-image
  processing tests against Sharp 0.35.3.
- `npm run build`: pass, 48/48 static pages generated.
- `docker compose build`: pass on the Linux production image; both `npm ci`
  stages reproduce the three-finding residual rather than the former tree.
- One-shot check inside `marblehouse-app:latest`: Sharp **0.35.3**, libvips
  **8.18.3**, Next **15.5.23**, Prisma **6.19.3**, PostCSS **8.5.26**, and a
  test JPEG encoded successfully.

The Better Auth/Edge Runtime warning and Prisma `package.json#prisma`
deprecation remain unchanged and are separate recorded debts. **No schema
change and no migration.**

---

### D-163 · Bind-mounted `/data` and `/backups` are root-owned — every write the app makes was failing

**Found 25 Aug 2026** while verifying the backup path after D-160/D-161, on the
same first-real-deploy box. Nothing had reported it because no staff had used
the features yet.

`docker-compose.yml` bind-mounts `./data:/data` and `./backups:/backups`. When
Docker creates a bind-mount source directory that does not exist, it creates it
as **root**. The container runs as `USER node` (uid 1000). A bind mount shadows
whatever is in the image at that path, so `Dockerfile:89`'s
`chown -R node:node /data /backups` applies to directories that are then hidden
by the mount and has no effect at runtime.

Result: uid 1000 could not write to either path. Verified directly —
`touch /data/.wtest` and `touch /backups/.wtest` both returned
`Permission denied` inside the running container.

**What was broken in production, silently:**

- `npm run backup` — `EACCES … mkdir '/backups/.staging-…'`.
- **The nightly 02:00 backup job** (`src/server/jobs/scheduler.ts` →
  `@/server/services/backup`). It writes to the same `/backups`, so automated
  backups had never once succeeded on this machine. §13's whole
  local-backup-plus-manual-copy design rests on this working.
- Every upload: attendance photos (`attendance-photo.ts`, `DATA_DIR`), expense
  receipts, prize images. Photo-proof clock-in is a §4 core feature and would
  have failed for the first staff member to try it.

**Fix:** `sudo chown -R 1000:1000 ./data ./backups` on the host. The host user
here is uid 1000, the same as the container's `node`, so one chown satisfies
both and leaves the owner normal file-manager access to the bind mounts.
Verified after: both paths writable, and a real
`npm run backup` produced `marblehouse-2026-08-25-2002.tar.gz` plus its
`.sha256` on the host.

**This will recur on any fresh deploy** — a new machine, a fresh clone, or the
Windows production target — because the directories are created by Docker on
first `up`, not by the repo. Two durable options, neither taken yet: commit
`.gitkeep` files so `./data` and `./backups` exist (owned by the cloning user)
before Docker can create them as root, or have `docker-entrypoint.sh` check
writability and fail loudly with the chown command rather than letting the app
start and discover it one failed upload at a time. **Prefer the loud check** —
a deploy that boots healthy while unable to write anything is precisely the
failure mode this whole day was made of.

**Pattern worth naming, since three separate faults today shared it.** D-159
(missing `src/`), the missing `scripts/`, and this one all passed
`docker compose build` and all broke only when the container actually ran.
`build` proves the image assembles. It says nothing about whether the thing
boots, whether it can reach its dependencies, or whether it can write to its
own volumes. The phase gate needs a runtime assertion, not just a build.

---

### D-164 · Login spinner hung forever on iOS Safari — soft navigation raced its own refresh

**Reported 25 Aug 2026**, after D-160 restored the tunnel: on the owner's
iPhone, submitting correct credentials in Safari span the "Signing in…" button
indefinitely. A *wrong* password failed instantly and correctly. Chrome on the
same phone worked. The home-screen PWA worked. Clearing Safari's website data
made it work once, then it broke again.

**Everything server-side was provably fine**, which is what made this look like
infrastructure for far too long:

- Every attempt created a fresh `session` row and updated `lastLoginAt` — the
  sign-in succeeded, every single time.
- Zero `429`s across 765 tunnel requests; the container was confirmed running
  D-161's `max: 30`.
- No exception in the app log during the hang.
- Every JS/CSS chunk the login page references returned `200`.
- The `404`s in the tunnel counters were `apple-touch-icon*.png` and
  `favicon.ico`, which iOS requests and this app does not ship. Harmless, and a
  red herring.
- HTTP/3 was suspected (Safari uses it, `alt-svc` is advertised, and clearing
  site data resets the alt-svc cache — which fit the intermittency neatly). It
  was tested directly and **disproved**: 174KB over `--http3-only` from the
  same wifi succeeded repeatedly.

**Cause, in our own code.** `login-form.tsx` ran, back to back:

```ts
router.replace(target);
router.refresh();
```

`replace()` begins a soft RSC navigation; `refresh()` immediately invalidates
the router cache underneath it. When those race, the navigation never resolves.
The success path deliberately never clears `pending` — normally there is
nothing to clear, because the page goes away — so the button spins forever. A
race explains every observation the network theories could not: the
intermittency, the variation by browser, and the fact that a *failed* login
(which returns early and does clear `pending`) always behaved correctly.

**Fix:** a hard navigation, `window.location.replace(target)`. The browser
re-requests the page with whatever cookie it just stored and no RSC cache in
the path. It also **fails visibly** — if the cookie did not stick, the user
lands on a rendered login page instead of an infinite spinner. A full reload is
marginally slower and entirely the right trade here.

**Not fixed, same pattern, deliberately left alone:**
`customers/[id]/redeem/redeem-cart.tsx:123-124` also does
`router.push(...)` immediately followed by `router.refresh()`. It has not been
reported broken. It is the same latent race; check it if a redemption ever
"hangs after confirming". Standalone `router.refresh()` calls elsewhere are
**not** affected — the race needs a navigation in flight.

**Caveat, stated honestly:** the race is a strong inference from the evidence,
not a captured stack trace — iOS Safari cannot be inspected without a Mac. The
fix is a strict improvement regardless of root cause, because it removes the
soft-navigation path entirely and converts any residual failure from an
infinite spinner into a visible page. If the spinner ever returns, that
inference is what to re-examine first.

---

### D-165 · The site answers on plain HTTP, and a `Secure` cookie cannot survive that

**Found by the owner, 25 Aug 2026**, after a long hunt through D-164: on iOS,
signing in over `http://` fails and over `https://` succeeds.

**Mechanism.** `useSecureCookies` resolves to true (`APP_URL` is https), so the
session cookie is issued as:

```
__Secure-marblehouse.session_token=…; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=lax
```

That is correct. But **a browser will not store a `Secure` cookie delivered
over plain HTTP.** Over `http://`, the login POST still succeeds — a real
`session` row is written server-side — and the browser then silently discards
the cookie. The next request arrives anonymous and `/` bounces to `/login`.
The failure is invisible from the server: auth logs look perfect.

**The actual defect is that plain HTTP is served at all.** Verified:

```
http://admin.redlight.click/login      -> 200   (not a redirect)
http://admin.redlight.click/api/health -> 200
Strict-Transport-Security               -> absent
```

Cloudflare was not configured to force HTTPS, so the origin answered both
schemes. **This is a security defect before it is a login defect:** credentials
and business data were transmittable in cleartext over shop wifi.

**Why it took so long to see.** Every clue pointed away from it:

- Chrome on the same iPhone worked — Chrome auto-upgrades typed URLs to HTTPS,
  so it was never on HTTP. This looked like "Safari is broken", and burned
  hours on Safari settings, content blockers, ITP and HTTP/3.
- The home-screen PWA worked — it had saved the `https://` URL.
- A wrong password failed correctly and instantly, because that path needs no
  cookie. That made auth look healthy.
- Sessions were created on every attempt, so the database "proved" login worked.
- D-164's spinner masked it entirely until the hard navigation made the bounce
  visible.

**Lesson for the next session: check the scheme before suspecting the browser.**
"Works in one browser, not another, on the same device" is a classic signature
of one client silently upgrading to HTTPS while the other does not. Confirm
what scheme is actually in the address bar first — it is one question, and it
would have replaced a multi-hour elimination hunt.

**Fix, applied and verified 26 Aug 2026:** Cloudflare → SSL/TLS → Edge
Certificates → **Always Use HTTPS**. Edge-level, so it holds no matter what
anyone types or bookmarks. Confirmed after enabling:

```
http://admin.redlight.click/           -> 301 https://admin.redlight.click/
http://admin.redlight.click/login      -> 301 https://…/login
http://admin.redlight.click/api/health -> 301 https://…/api/health
following the chain                    -> 200 at https://…/login
```

Note the first attempt at this toggle did not take — plain HTTP still returned
`200` from Cloudflare's own edge. Cloudflare has three similarly-named settings
and only one is right: **Always Use HTTPS** (redirects the request),
*Automatic HTTPS Rewrites* (only rewrites http links inside HTML) and
*Opportunistic Encryption* (unrelated). Verify with a real `curl` against
`http://`, not by trusting the dashboard.

**HSTS is ON as of 26 Aug 2026**, `max-age=15552000` (6 months), verified on
`/`, `/login`, `/api/health` and `/sale`. Without it the first request a
browser makes still leaves over plaintext before being redirected.

Gotcha worth knowing: enabling HSTS in Cloudflare while leaving the **Max Age**
dropdown at `0` emits `strict-transport-security: max-age=0`, which is the
explicit *disable* value — it instructs browsers to forget any policy. The
header being present proves nothing; check the value.

`includeSubDomains` and `preload` are deliberately **off**. `includeSubDomains`
would force HTTPS on every `*.redlight.click`, breaking any sibling subdomain
still on plain HTTP; `preload` is baked into browser binaries and is very hard
to reverse. Neither is needed for this app.

No renewal is required — `max-age` is a rolling window refreshed on every
response, not an expiry date. It only lapses for a device that does not visit
for six months, which then simply receives the header again.

**Still open — defence in depth not yet added.** The app itself does not refuse
plain HTTP; it relies entirely on the edge setting being right. A middleware
check on `x-forwarded-proto` would make the app self-protecting if the tunnel
is ever reconfigured or replaced. Not done here because a proto check behind a
proxy can loop if the header is absent, and that deserves its own careful
change rather than being tacked onto an incident fix.

---

### D-166 · The Apple touch icon pointed at an SVG, which iOS cannot use

**Found 26 Aug 2026** while clearing the `404`s that surfaced during D-160's
tunnel diagnosis. `/apple-touch-icon.png`, `/apple-touch-icon-precomposed.png`
and `/favicon.ico` were all 404, and iOS requests them repeatedly.

They were dismissed as cosmetic at the time. They were a symptom.

`layout.tsx` declared `icons.apple = "/icon.svg"`, with a comment noting that
iOS ignores the manifest's icons array and looks here instead — correct, but
incomplete: **iOS cannot use an SVG for `apple-touch-icon`.** It silently
discards a non-PNG link, falls back to probing `/apple-touch-icon.png` and
`/apple-touch-icon-precomposed.png` at the root, and when those 404 it uses a
screenshot of the page as the home-screen icon. So "Add to Home Screen"
produced a blurry render of the login form rather than the marble.

**Fix:** real PNGs, generated from the existing artwork so nothing new was
invented — `public/apple-touch-icon.png` (180×180), the `-precomposed` twin
older iOS probes first, and a multi-resolution `public/favicon.ico` (16/32/48)
from `icon.svg`. `icons.apple` now points at the PNG.

**Two properties of the Apple icon are deliberate and must not be "tidied":**

- **Full-bleed, not rounded.** `icon.svg` has `rx="112"` with transparency
  outside the corners. iOS applies its own mask and composites transparency
  onto **black**, so shipping the rounded art would frame the icon in black
  wedges. The generated PNG is edge-to-edge `#dc2626` and carries no alpha
  channel at all (verified: `RGB`, corner pixel `(220,38,38)`).
- **Sized from `icon.svg`, not `icon-maskable.svg`.** The maskable variant
  shrinks its artwork into Android's 80% safe zone (see its own comment). iOS
  crops far less, so reusing it would render a needlessly small marble adrift
  in red. The Apple source therefore takes `icon.svg`'s geometry with
  `icon-maskable.svg`'s full-bleed background — neither file on its own is
  correct for iOS.

Generated with `rsvg-convert` + `magick` from the committed SVGs, so the
artwork remains drawn-not-imported per D-7 and no build-time download is
involved. The PNGs are committed rather than generated at build time,
deliberately: they are tiny, and a build step here would be a new failure mode
for no benefit.

### D-167 · `theme_color` was the brand red, tinting the iOS status bar against an all-white app

**Found by the owner, 26 Aug 2026**: on iOS the top bar (clock/battery/signal
area) rendered red instead of white, standing out against the rest of the
screen.

`layout.tsx`'s `viewport.themeColor` and `manifest.ts`'s `theme_color` were
both `#dc2626` — the same red as the app icon background (D-166). iOS uses
`theme-color` to tint the system chrome around the status bar (in ordinary
Safari tabs) and, via `statusBarStyle: "black-translucent"`, lets the
translucent status bar reveal whatever's actually behind it once installed to
the home screen. Either way, the color needs to match the app's own
background, not the icon's.

The in-app UI is entirely white/grayscale — `globals.css`'s `--background` is
`oklch(1 0 0)` and nothing in `src/app` or `src/components` paints a red app
bar or header. `--color-brand-600: #dc2626` is defined in the theme but is
unused outside the icon SVGs. So the icon is red, the running app is not, and
using the icon's red for `theme-color` was the bug, not a stray CSS rule.

**Fix:** both values changed to `#ffffff`, matching `--background` and the
manifest's existing `background_color`. `statusBarStyle` stays
`black-translucent` — with a white theme color that now blends into the
white page instead of standing out.

If the app ever grows an actual colored top app bar, `theme-color` should be
revisited to match *that*, not the icon.

### D-168 · Installed on the home screen, the app runs truly edge-to-edge — the bottom nav's outer labels clipped on the corner curve

**Found by the owner, 26 Aug 2026**, immediately after D-167, on the same
iPhone: with the app added to the home screen (no Safari chrome at all), the
bottom tab bar's leftmost and rightmost labels ("Dashboard", "Settings") were
partly cut off by the screen's rounded bottom corners.

Cause: `display: standalone` + `statusBarStyle: "black-translucent"` (both
already deliberate, D-167) mean the page occupies the *entire physical
screen*, not a Safari-chrome-inset rectangle. `AppShell`'s bottom nav is
`fixed inset-x-0 bottom-0` with no allowance for that — its content sat
exactly at the true screen edges, which is precisely where the corner radius
and the home-indicator gesture bar live.

**Fix**, all in `AppShell` plus one viewport flag:

- `viewport.viewportFit: "cover"` added in `layout.tsx`. Required for
  `env(safe-area-inset-*)` to resolve to anything but `0` — without it every
  fix below is a silent no-op.
- Bottom `<nav>` gets `pb-[env(safe-area-inset-bottom)]` (clears the home
  indicator) and its `<ul>` gets
  `pl-/pr-[max(0.5rem, env(safe-area-inset-left/right))]` — the `max()` floor
  is what actually fixes the reported bug, since the *left/right* inset is 0
  on every current iPhone in portrait. It's a fixed 8px gutter dressed as a
  safe-area rule so it still grows correctly in landscape on Dynamic Island
  models.
- `<main>`'s bottom padding grew from `pb-24` to
  `pb-[calc(6rem+env(safe-area-inset-bottom))]` so page content clears the
  now-taller nav.
- Header gets `pt-[env(safe-area-inset-top)]` for the same reason on the
  other edge, pre-emptively — not reported broken, but the same edge-to-edge
  cause applies, and the header's white background already matches the
  status bar (D-167), so pushing its content down costs nothing visually even
  where the inset is 0.

**Only reproduces installed to the home screen**, not in an ordinary Safari
tab — Safari's own chrome already insets the page there, so `env()` returns 0
and nothing above does anything. Test on-device with "Add to Home Screen",
not just in Safari.

### D-169 · Settings → Backups was a 404 — the screen and its three routes were never actually committed

**Found by the owner, 26 Aug 2026.** Logging in and opening Settings →
Backups returned "page not here." The backup *engine* was never in doubt —
`backup.ts`, the 02:00 cron job, `restore.sh` and 278 lines of
`backup.test.ts` are all real, committed in the Phase 9 commit
(`b70e1af`), and were running nightly on this machine the whole time. What
was missing was everything that lets the owner SEE or TRIGGER any of it from
the website.

`docs/BUILD-LOG.md`'s own "What Phase 9 built" section (above) has always
listed `src/app/(app)/settings/backups/{page.tsx,backup-screen.tsx}` and
`src/app/api/backups/{route.ts,download/route.ts,offsite-copy/route.ts}` as
shipped, and `settings/page.tsx` has linked to `/settings/backups` since the
same commit. None of those five files were ever in the repository —
`git log --all --full-history` on every plausible path returns nothing, in
any commit, ever. So this was not a regression (nothing deleted them) and not
a divergence between docs and code that crept in over time — the Phase 9
commit itself never contained them, despite the commit message and the build
log both describing a finished screen.

**It gets more specific than "never built," though.** The "Known issues /
debts" table's D-115 follow-up entry cited `settings/backups/backup-screen.tsx:72`
by name and line number, describing a real locale bug in a `.toLocaleString()`
call. Nobody invents a line number for a file that was never written — so at
some point a session had a working draft of this screen open and reviewed it
closely enough to log a bug against a specific line.

**Root cause found, not just guessed at:** `.gitignore` had a bare
`backups/` entry (and a bare `data/`), meant only for the top-level runtime
directories where archives and attendance photos actually live —
`git check-ignore` confirms it also matches ANY directory named `backups`
anywhere in the tree. `src/app/(app)/settings/backups/` and
`src/app/api/backups/` both qualify. An ignored file is invisible to plain
`git status`, `git add -A`, and `git diff` alike — the session that wrote
this screen would have seen a clean working tree with nothing to commit,
identically to how it looks right now if you run `git status` without
`--ignored`. `git status --porcelain --ignored=matching` was run over the
rest of `src/`, `scripts/`, `docs/`, `prisma/` and `public/` as a check for
anything else this pattern might have swallowed the same way — nothing else
matched. **Fixed** by anchoring both entries to the repo root (`/data/`,
`/backups/`) so they only ever match the two real runtime directories.

This is still worth filing next to D-25 (the Phase 3 migration that also sat
uncommitted for a while) as the same underlying lesson: **a file existing on
disk is not "done" until `git add`/`git commit` says so, and "done" is not
provable by eye when the tool meant to show you the gap is the one silently
hiding it.** The generalisable habit: an unanchored `.gitignore` pattern is
a landmine anywhere the repo might later grow a same-named directory for a
completely unrelated reason, which `src/.../settings/backups/` did the
moment Phase 9 needed a URL segment matching the runtime folder's name.

**Fix:** rewrote all five files from the existing, well-tested service
contract in `backup.ts`, using `scripts/verify-phase9.sh`'s own 76 assertions
as the spec — that script already pins down the exact JSON shapes
(`GET /api/backups` → `{status, runs, archives}`, `POST /api/backups` →
`{ok, fileName, sizeBytes, retention}` with `fileName` at the top level,
`POST /api/backups/offsite-copy` → `{copiedAt, fileName}`), the permission
matrix (OWNER only; MANAGER/STAFF 403 on every route and the page), the
download route's traversal handling, and the no-word-"dismiss" requirement on
the red banner. Two things worth a future reader knowing:

- `runs[].sizeBytes` and `BackupRun.filePath` are not passed through as-is:
  Prisma's `sizeBytes` is a `BigInt`, which `JSON.stringify`/`NextResponse.json`
  throw on, so the route narrows it to `Number` (backup sizes are nowhere
  near 2^53 bytes); `filePath` is a server-absolute path and is dropped from
  every response — the client never needs more than the `fileName` it already
  uses to build a download URL.
- `POST /api/backups` and `POST /api/backups/offsite-copy` deliberately do
  **not** take an `Idempotency-Key`, unlike every other mutation route in the
  app. This matches the actual signatures `runBackupNow`/`recordOffsiteCopy`
  already shipped with in Phase 9 (neither accepts a `tx`, which the
  idempotency helper requires to commit the key with the work). A double-tap
  on either is harmless — a repeat backup just creates a second archive
  (wasteful, not corrupting) and a repeat copy-log just overwrites the same
  `AppSetting` value — so this reproduces the original design rather than
  patching around it.

**Verification.** This machine has no native Node — it is production, Docker
only — so all four gates ran in containers, never against the live
`marblehouse` database. `docker compose build app` was run for real (it
succeeded; `/settings/backups` appears in the route manifest at 5.01 kB, and
typecheck runs inside `next build` per `next.config.ts`'s
`typescript.ignoreBuildErrors: false`). `npm run lint` and `npm test` ran in
a disposable `node:22-bookworm-slim` container against a fully disposable
Postgres (`docker-compose.dev.yml`, project `marblehouse-verify`, its own
network/volume, torn down afterward) — migrated and seeded exactly like a
fresh dev machine would be, DATABASE_URL pointed at a `_test`-suffixed name
so `setup.ts`'s guard would refuse anything else. Lint: clean. Full suite:
**511/511 passing across all 28 files**, including the 13 in `backup.test.ts`
this change did not touch. `scripts/verify-phase9.sh` was **not** run here — it needs the
Phase 8 seeded fixture accounts (`owner`/`p8mgr`/`p8staff` with fixed
passwords) and a native `psql`/`dropdb` on the host to build a scratch
restore database, none of which exist on this production install, and
running it would mean logging real backup archives and audit rows against a
live business. Its assertions were instead read in full and matched against
this code by hand, field by field, which is where the response shapes above
came from.

**Still outstanding, unchanged by this fix:** the §16 restore rehearsal onto
a second physical machine (Phase 9's own row has said this since 8 Aug) — the
owner's to do, not something a screen existing changes.

### D-170 · Lid-close now stays up — host-level `systemd-logind` config, not part of the repo or Docker image

**26 Aug 2026.** The production machine is a laptop (D-159/D-169 already
establish this box as "production, Docker only, no native Node"). By
default, closing the lid suspends it — which would take down Postgres, the
app containers and the `cloudflared` tunnel every time the lid closes,
cutting every branch off. The owner confirmed the intent: keep the desktop
GUI (not comfortable with SSH-only headless), just stop the lid from
suspending anything.

**Fix — applied directly on the host, as root, outside git and outside
Docker:**

```bash
sudo mkdir -p /etc/systemd/logind.conf.d
echo -e '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore' | \
  sudo tee /etc/systemd/logind.conf.d/no-lid-suspend.conf
sudo systemctl restart systemd-logind
```

This drops a config file that `systemd-logind` reads on every boot, on
battery and on AC alike — lid close becomes a pure no-op at the OS level: no
suspend, no hibernate, nothing pauses. The Docker stack, Postgres and the
tunnel are completely unaffected either way (they don't look at the lid at
all); this is purely about keeping the *host* awake so those containers keep
running.

**One sharp edge, confirmed against the journal, not guessed:** this machine
runs GNOME on Wayland. Restarting the *live* `systemd-logind` process while
already logged into a graphical session tears the session down —
`journalctl` for the restart window shows `Connection to xwayland lost` and
GDM spawning a brand-new session a few seconds later. On this machine the
screen went black and needed a manual restart to get the GUI back; the new
session came up cleanly in the logs, but the transition is visibly rough on
real hardware. **Only the initial `systemctl restart systemd-logind` causes
this** — because the config file itself is read at boot, before any session
exists, a normal reboot or the next natural power-on never touches a live
session and never has this problem. Do not restart `systemd-logind` live
again for any future logind tweak; reboot instead.

**Why this belongs in the build log and not just a chat:** none of this is
in the git repo — it's host OS configuration on `/etc`, invisible to
`git status`, `docker compose build`, and every phase gate. A restore onto a
second machine (the still-outstanding §16 rehearsal) or a full box
replacement will boot with the *default* lid-suspend behavior unless this
drop-in is recreated by hand. See the matching row in "Known issues / debts".

**Verification.** Confirmed live and after the fact: `systemctl status
systemd-logind` showed `Active: active (running)` post-restart, and
`cat /etc/systemd/logind.conf.d/no-lid-suspend.conf` showed both directives
in place. `CLAUDE.md`'s "Docker is production only (Windows)" line was also
corrected to Linux while this was fresh — that note had been stale since
before this session and would have sent a future agent looking for
Windows-specific service-restart commands on a Linux box.

**Second, more serious gap found the same day, checking a follow-up question
about backlight behavior:** the `logind` drop-in only disables the
lid-*switch* action. GNOME has its own, entirely separate idle-based
suspend, driven by `gnome-settings-daemon`'s power plugin, and it was live:

```
$ gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-timeout
900
$ gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type
'suspend'
$ gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-battery-timeout
900
$ gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type
'suspend'
```

15 minutes of no keyboard/mouse input, on AC **or** battery, and GNOME
suspends the machine itself — completely independent of the lid switch and
untouched by D-170's `logind` config. Closing the lid is exactly the
condition that produces 15 idle minutes with nobody able to touch the
keyboard, so **this would have silently undone the whole fix** roughly a
quarter of an hour after every lid-close, taking Postgres/the app
containers/the tunnel down anyway. Confirmed the `sleep-inactive-ac-type`
schema key exists and there is no separate lid-close screen-off action in
this GNOME version (`gsettings list-keys
org.gnome.settings-daemon.plugins.power` has no lid-specific key) — the idle
timeout was the only remaining suspend path.

**Fixed** by disabling both:

```bash
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing'
```

**This is per-user `dconf` state (`~/.config/dconf` for `delvino`), not
system config** — a different persistence mechanism from the `logind`
drop-in, and it needs its own note for a restore/new-device setup: it
travels with the user's home directory / dconf database, not with `/etc`,
and not with the git repo either. A fresh OS install or a different Linux
user account will default back to `'suspend'` and reintroduce this exact
gap. Re-run the two `gsettings set` commands above (no reboot or restart
needed — they take effect immediately) any time this app is set up on a new
machine or a new OS user.

The screensaver's own idle blank (`org.gnome.desktop.session idle-delay`,
300s) was left untouched — that only powers off the backlight via DPMS after
5 minutes of inactivity, the same as it would with the lid open and nobody
at the keyboard. It doesn't suspend anything, costs nothing, and is why the
screen goes dark on its own even with the lid open: the backlight itself
stays lit immediately on lid-close and only turns off later, on that normal
5-minute idle timer — never as a direct reaction to the lid.

### D-171 · Clock-in geolocation: timeout and denial were indistinguishable

**Owner report, 26 Aug 2026:** location permission was granted in the
browser, but a clock-in photo still came back `LOCATION UNAVAILABLE`. This is
exactly the class of gap D-51 warned about — the only prior verification of
this path used a **stubbed** `navigator.geolocation`, never a real permission
prompt racing real GPS hardware.

**Root cause**, `clock-in-flow.tsx`'s old `getPosition()`: the
`getCurrentPosition` error callback was `() => resolve(null)` for every
failure mode — permission denied, no fix available
(`POSITION_UNAVAILABLE`), and a timed-out `enableHighAccuracy: true` request
(8s) all collapsed to the same `null`, which the server stamps as
`LOCATION UNAVAILABLE` regardless of which one actually happened. Confirmed
against the live DB: one real check-in that day (`staff` Stevy, 06:37) has
valid lat/long with `locationDenied: false` — so the capture path works when
the GPS fix lands in time; it's a race against the timeout, not a permission
problem, which matches the owner confirming the failing attempt was a
*separate* try from the one that saved successfully.

**Fixed**, three parts, all client-side in `clock-in-flow.tsx`:
1. `getPositionOnce()` now reads `error.code` and returns a `LocationReason`
   (`"denied" | "timeout" | "unavailable" | "unsupported"`) instead of
   collapsing every failure to `null`.
2. On a `timeout` or plain `unavailable` from the first (high-accuracy, 8s)
   attempt, `getPosition()` retries **once** at `enableHighAccuracy: false`
   (5s) — a Wi-Fi/cell-based fix, faster and more likely to land indoors. A
   `denied` result is never retried.
3. The clock-in confirmation screen now shows which reason actually applied
   (`locationReasonMessage()`) instead of one generic sentence, so staff and
   the owner can tell "you said no" apart from "the device couldn't get a
   fix."

**Explicitly preserved, per owner instruction:** a missing/failed location
still never blocks the clock-in. `locationDenied` is still sent to the
server exactly as before when no position was obtained — only the *client's
own* reasoning about why is new; nothing changed in
`src/server/services/attendance.ts` or the schema.

**Verified:** `tsc --noEmit` and `next lint` both clean (run inside a
throwaway image built from this source — this box has no native
`npm`/`node`, only the Docker runtime; see the note this session left in
*Known issues / debts*). `docker build --target builder` succeeds, which
exercises `next build`'s own typecheck. No service-layer or schema change,
so `npm test` and the existing Vitest suite are unaffected; not re-run for
this fix.

**Still open, unchanged from D-51:** this remains unverified against a real
device's permission prompt end-to-end (this fix could only be typechecked
and built, not clicked through, from this box). The next real check-in
attempt on hardware is the actual test.

### D-172 · The end-of-shift banner's "Clock out" was a link to a page, not an action

Reported from the shop floor: at 22:09, with the amber "YOUR SHIFT HAS ENDED
— Evening ended at 22:00" banner up, tapping **Clock out** "doesn't do
anything."

**It was never a button.** The whole banner was a single
`<Link href="/attendance">`, and the pill inside it was a `<span>` styled to
look like a button. Tapping it navigated to Attendance and stopped there. The
banner then *stayed on screen* — it clears only when the record is actually
closed — so the obvious next move was to tap it again, which re-navigated to
the same page. From the user's side that is indistinguishable from a dead
control.

Worth being precise about what was NOT broken, because the first instinct is
to suspect the API: `POST /api/attendance/clock-out`, the `clockOut` service
and `ClockOutCard` were all fine. Verified by logging in as `dewa` (who had a
same-day open record), opening the card and submitting — "Clocked out at
14.53." The defect was purely that the banner never reached that dialog.

**Fixed by making the banner deep-link to the record**, not merely to the
screen:

- `attendanceStatus` now returns `clockOutPrompt.attendanceId`. It has to name
  the *specific* row: a split-shift employee can hold two open records, and
  "the open one" would open the wrong dialog.
- The banner links to `/attendance#clock-out=<id>`.
- `ClockOutCard` resolves that fragment **after** its fetch resolves (the hash
  names a record it has not loaded yet), opens the confirm dialog for it, then
  consumes the fragment via `replaceState` so a refresh or a Back does not
  reopen a dialog the person deliberately cancelled. An id that no longer
  matches an open row — already closed in another tab — opens nothing.
- A second effect listens for `hashchange`. Tapping the banner while *already
  on* `/attendance` changes only the hash, so the page never remounts and the
  fetch effect never re-runs; without this the second tap stayed dead, which is
  the same bug in a narrower case.

**Why deep-link instead of making the pill POST directly.** A one-tap banner
cannot serve the overdue path. Once a record has been open more than twelve
hours past its scheduled end, the API requires both a reason and a confirmed
finish time, and silently POSTing "now" would invent a shift length — exactly
what the card's own header comment warns against. The dialog is where those
two fields live, so the banner's job is to *open* it, not to bypass it.

**Verified in the browser as BOTH roles**, not just typechecked. The fix is
role-independent by construction — `ClockOutCard` renders outside every
`canSeeTeam` / `showMyAttendance` conditional in `attendance-list.tsx`, and
`clockOut` scopes on `actor.userId` with no role gate — but "by construction"
is exactly the reasoning D-34 warns about, so both were actually clicked:

- **MANAGER** (`manager`, overdue 2026-08-20 record): the deep link opened the
  dialog showing "Overdue clock-out — reason and actual finish time required",
  the datetime pre-filled, and **Confirm clock out** disabled until both were
  supplied. Cancel left the URL clean at `/attendance`; a subsequent hash-only
  change reopened it, confirming the `hashchange` path.
- **STAFF** (`ratu`, STAFF at both branches, `isOwner: false`, no MANAGER row
  anywhere): the same deep link opened the ordinary (non-overdue) dialog, and
  submitting it emptied `openRecords` — a real clock-out, by a pure staff
  account, reached from the banner's own URL. The temporary record used for
  this was deleted afterwards along with its audit row; `ratu` is back to her
  two pre-existing closed records.

`attendanceStatus` was also probed directly for `ratu` before that: `required:
true` with `clockOutPrompt: null` only because she held no open record at the
time — role was never what suppressed it.

The existing `clockOutPrompt` test asserted the object's exact shape and so
failed the moment `attendanceId` was added — the suite caught the change
rather than sleeping through it. It now asserts the id equals
`openRecords[0].id`, which is the contract the banner actually depends on: if
the prompt ever names a record the card is not offering, the tap opens nothing
and the original bug is back.

**Gate not run:** `docker compose build` — the Docker daemon is not running on
this machine. No import paths changed (three existing files edited in place),
so the case-sensitivity failure that gate exists to catch is not in play here,
but the check is genuinely unrun rather than passed.

**Left alone deliberately:** `manager`'s overdue 2026-08-20 record is still
open. Closing it during testing would have written a fabricated ~260h shift
into real data.

