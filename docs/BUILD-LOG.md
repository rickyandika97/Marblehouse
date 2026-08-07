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
| 8 | Dashboards and reports | ⬜ Next |
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

```bash
npm run typecheck                 # clean
npm run lint                      # clean
npm test                          # 131 tests (D-26) — safe to re-run, no residue
docker compose build              # succeeds (catches Linux case-sensitivity)
bash scripts/verify-phase1.sh     # 21/21 acceptance checks, needs npm run dev
bash scripts/verify-phase2.sh     # 30/30 acceptance checks, needs npm run dev
bash scripts/verify-phase3.sh     # Phase 3 PASS, needs npm run dev
bash scripts/verify-phase4.sh     # 35 checks, needs npm run dev
bash scripts/verify-phase5.sh     # 42 checks, needs npm run dev
bash scripts/verify-phase6.sh     # 41 checks, needs npm run dev
bash scripts/verify-phase7.sh     # 44 checks, needs npm run dev
```

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

## Known issues / debts

| Item | Detail |
|---|---|
| Prisma deprecation | `package.json#prisma` moves to `prisma.config.ts` in Prisma 7. Not urgent. |
| Dependency audit | `npm audit --omit=dev` reports 6 high advisories through Prisma's `effect` dependency and Next's PostCSS/sharp dependencies. The offered automatic fix upgrades outside the pinned stack (Prisma 6.19 / Next 16), so Phase 3 did not force it. Reassess as an explicit dependency/hardening update. |
| Edge Runtime build warning | From `jose` inside Better Auth. Harmless — we do not use the Edge Runtime (§5.2 forbids it) and nothing enables it. |
| Phases 1–3 have no unit tests | Vitest landed in Phase 4 (D-26), and `npm test` is a phase gate from Phase 4 onward (D-37). Phases 1–3 shipped before either existed and are covered only by the curl-based `verify-phase{1,2,3}.sh`. §15's remaining unit tests — business-date boundaries at 03:59/04:00/23:59, lateness at the grace boundary, phone normalisation — have no home yet. **Add each as its phase comes up** (lateness with Phase 6, for example) rather than in one late sweep; the business-date cases are the exception and are worth backfilling sooner, since every phase stamps `businessDate` and D-18 made the rule global. |
| ~~Red attendance banner~~ | **Built in Phase 6.** Not dismissible, and it does not block work (D-45). |
| Clock-out has no UI | `POST /api/attendance/clock-out` exists, is tested and works; nothing calls it. §4.13 says v1 lateness is clock-in only, so this is not on the critical path — but a shift with no clock-out looks unfinished on the team screen. Wire a button into the attendance screen in Phase 10. |
| Clock-out photo is not captured | `Shop.requireClockOutPhoto` and `Attendance.clockOutPhotoPath` both exist and the purge job already clears the file. Nothing writes it. §4.13 makes it optional and per-shop; build it with the clock-out button. |
| No attendance reporting surfaces | §8.9 also asks for a calendar heatmap, a ranked lateness table and a weekly trend chart. Those are reporting, and Phase 8 owns reports — the data (`isLate`, `lateMinutes`, `businessDate`) is all recorded and indexed for them. |
| No expense edit or receipt UI | `PATCH /api/expenses/:id` and `POST /api/expenses/:id/receipt` both exist, are permission-checked and are covered by tests; no screen calls either. §8.8 asks for an optional receipt photo on the add form. The service and storage are done — this is a UI-only gap. |
| Expense list has no filters or pagination UI | The service takes `categoryId`, `from`, `to` and a cursor, and returns `nextCursor`; the screen renders the first page for the work-session shop with no date-range or category filter and no "load more". §8.8 specifies all three. Phase 8 owns expense *reporting* and is the natural place. |
| Expenses live under Settings | D-58. Reachable but not where anyone looks for a daily task. Phase 10's "More" tab (D-36) should carry it. |
| Excuse reason uses `window.prompt` | Third site now, after the sale void and the transfer cancel. Replace all three together in Phase 10. |
| Shop switcher is 32px tall | The top-bar "Branch 1" control in `app-shell.tsx` (Phase 1) is below NF-3's 44px floor. Allowed by §8.11 only because a larger equivalent exists at Settings → Current shop, so it is not the *only* way to switch. Raise it in Phase 10's responsive pass. Found by measuring the rendered page (D-51). |
| Duplicate shifts render unfiltered | The clock-in chooser showed **11** shifts at BR-1, including four identical `Verify Shift` rows — accumulated `verify-phase6.sh` data, not a code bug (`npm run db:reset` clears it). But nothing in the UI or the service guards against genuinely duplicate shift names, and staff would see the same confusing list. Consider a uniqueness rule or a dedupe on the chooser when shift management gets its Phase 10 pass. |
| ~~`Button render={<a>}` a11y warning~~ | **Fixed 7 Aug 2026 — see D-53.** `nativeButton` is now derived in the wrapper, covering all eight sites and every future one. |
| Dashboard screen | Route + permission boundary only. Metrics are Phase 8. |
| ~~`Shop.dayStartHour` still exists~~ | **Resolved same day — see D-18.** Dropped; the cutoff is global at 04:00. |
| No UI for the business-day hour | §8.10 puts it under Owner → System. It is set by seed/migration only. Build the screen in Phase 9 with the other owner settings; changing it needs a warning that it does not restamp history (D-18). |
| Idempotency keys are never deleted | D-16. The cleanup job is Phase 9. Rows accumulate one per mutation until then; harmless but unbounded. |
| Void reason uses `window.prompt` | Functional and accessible, but ugly on a tablet and it cannot enforce the 3-character minimum client-side (the server does). Replace with a proper dialog in Phase 10's polish pass. **The Phase 5 transfer-cancel reason uses the same prompt and should be replaced at the same time.** |
| Transfers are single-line in the UI | The API accepts up to 100 lines per transfer and the service handles them; the dispatch form sends one prize at a time. Multi-line dispatch is a UI change only — no service or schema work. Worth doing in Phase 10 if branches move mixed boxes often. |
| Opname counts every stocked item | `startOpname` accepts `prizeItemIds` to count a subset, but the screen always starts a full count. §8.7 says "select items or all". Partial counts are supported server-side; the picker is not built. |
| No in-transit column on the On hand tab | §8.7 lists one. `inTransitTo()` exists in `transfers.ts` and returns the figure per prize, but the On hand table does not render it yet. Wire it up in Phase 8 with the other stock reporting, or sooner if a manager asks where a box went. |
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
