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


---

## Known issues / debts

| Item | Detail |
|---|---|
| `verify-phase4.sh` cannot run — wrong path | Line 11 is `cd /Users/ricky/redlight`, the project's former name. Same defect D-99 fixed in `verify-phase1.sh`; found while writing `verify-shops.sh` (D-102) and left alone as out of scope. It should resolve the repo from `$(dirname "$0")/..` like the others. Check the remaining `verify-phase*.sh` for the same line. |
| Shop admin has no edit form | D-101 shipped create, plus deactivate/reopen from the list. Changing a shop's name, address, phone, grace or toggles after creation is supported by `PATCH /api/shops/:id` and covered by tests, but has **no UI** — only the activate toggle is wired. An owner who mistypes a name must call the API. |
| ~~Presets have no owner screen~~ | **Fixed — D-103.** Settings → Shops → *shop* → Sale prices. Reported by the owner within a day of D-101 shipping. |
| ~~Shifts have no owner screen~~ | **Fixed — D-105.** Settings → Shops → *shop* → Shifts, manager-or-owner. |
| ~~Staff assignment is a separate journey~~ | **Fixed — D-107.** Settings → Shops → *shop* → Staff. It was not merely wayfinding: `PATCH /api/users/:id` had no UI caller at all. |
| ~~Settings → Users is create-only~~ | **Fixed — D-109.** Rename, role, shops, Purchasing, deactivate and password reset all editable. |
| Existing usernames with a dash predate D-110 | The plugin now accepts dashes, matching our schema. Any account someone *tried* to create with a dash before today failed outright, so there is nothing to migrate — but if a future change touches `usernameValidator`, the service regex in `users.ts` must move with it. |
| Date formatting has the same portability exposure as D-115 | Not fixed — found while diagnosing D-115 and deliberately left, since neither is today's bug. Two shapes. **(a)** Seven `toLocaleTimeString`/`toLocaleDateString("id-ID")` call sites pass no `timeZone`, so they format in the *viewer's* zone: a server on `Asia/Jakarta` and a branch tablet on `Asia/Makassar` render the same instant an hour apart, and any of these that are server-rendered will throw a hydration error exactly as the preset tiles did. Pass `timeZone: "Asia/Jakarta"` explicitly. **(b)** `settings/audit-log/page.tsx:93` and `settings/backups/backup-screen.tsx:72` pass `undefined` as the *locale*, which resolves to the viewer's — guaranteed to differ on any non-`en-US` browser. Both are owner-only screens, which is why they have not been reported. Verified harmless on the owner's own machine today (Node 26 and Chrome agreed on every timestamp tested, midnight rollover included), so this is latent, not live. |
| Prisma deprecation | `package.json#prisma` moves to `prisma.config.ts` in Prisma 7. Not urgent. |
| Dependency audit | `npm audit --omit=dev` reports 6 high advisories through Prisma's `effect` dependency and Next's PostCSS/sharp dependencies. The offered automatic fix upgrades outside the pinned stack (Prisma 6.19 / Next 16), so Phase 3 did not force it. Reassess as an explicit dependency/hardening update. |
| Edge Runtime build warning | From `jose` inside Better Auth. Harmless — we do not use the Edge Runtime (§5.2 forbids it) and nothing enables it. |
| Phases 1–3 have no unit tests | Vitest landed in Phase 4 (D-26), and `npm test` is a phase gate from Phase 4 onward (D-37). Phases 1–3 shipped before either existed and are covered only by the curl-based `verify-phase{1,2,3}.sh`. **§15's named unit tests are now all in place** — lateness (Phase 6), business-date boundaries and phone normalisation (D-91). What remains uncovered is Phases 1–3's *service* logic, not §15's list. |
| §15's "money arithmetic never produces a float artefact" has no test | The last unticked line in §15's "Unit tests — other" block. `Decimal` is used throughout and D-13/D-85 caught the `Number()` slips by review, but nothing asserts it. A cheap property-style test over the money helpers would close it. |
| ~~Red attendance banner~~ | **Built in Phase 6.** Not dismissible, and it does not block work (D-45). |
| ~~Clock-out has no UI~~ | **Built — D-81.** A card on /attendance showing the shift's scheduled end time. Deliberately no second banner. |
| Clock-out photo is not captured | `Shop.requireClockOutPhoto` and `Attendance.clockOutPhotoPath` both exist and the purge job already clears the file. Nothing writes it. §4.13 makes it optional and per-shop; build it with the clock-out button. |
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
