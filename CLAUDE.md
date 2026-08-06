# Marblehouse — agent guardrails

Read, in this order, before writing code:

1. **This file** — the rules you must not violate.
2. **`docs/BUILD-LOG.md`** — what has actually been built, and every decision
   taken during construction. **Where it disagrees with the PRD, it wins.**
3. **`docs/PRD.md`** in full — the specification.

> **`prisma/schema.prisma` is the authority on the data model.** §6 of the PRD
> was reconciled against it at the end of Phase 1 and currently matches, but the
> code wins if they ever drift again. Several things in the auth models look
> wrong and are deliberate — read `docs/BUILD-LOG.md` before you "fix" any of
> them.

**`docs/BUILD-LOG.md` is the handoff between sessions.** Read it first; update
it before you call a phase finished — see *Before finishing any phase* at the
bottom of this file for exactly what to write.

## What this is

A self-hosted pinball arcade management system. Sales, customer marble and
ticket balances shared across branches, FIFO prize inventory, staff attendance
with photo proof, expenses, and owner reporting. One central server behind a
Cloudflare Tunnel; branches connect over the internet.

## Working agreement

- **Build one phase at a time.** Phases are in PRD §16. Do not implement
  features from a later phase, even if they seem trivial. Do not start the next
  phase until the current phase's acceptance criteria pass.
- **Ask, don't guess.** If a requirement is ambiguous, stop and ask. A wrong
  guess about money or stock is expensive to unwind later.
- **The owner is not a backend developer.** Explain tradeoffs in plain language
  before making a structural decision.

## Stack — do not substitute

Node 22 · Next.js 15 App Router · TypeScript strict · PostgreSQL 16 ·
Prisma 6 · Tailwind v4 · Zod · argon2 (`@node-rs/argon2`).

**Nothing may depend on Vercel.** No `@vercel/*`, no edge runtime, no
Vercel Blob/KV/Postgres, no CDN-dependent ISR. This is self-hosted on the
owner's own machine.

## Architecture rules

1. **Route handlers do three things only:** authenticate, validate with Zod,
   call a service. No business logic in `app/api/**`.
2. **All business logic lives in `src/server/services/`.** All Prisma
   transactions live there too.
3. **Use route handlers for mutations, not Server Actions.** Explicit endpoints
   are easier to test, log and debug.
4. **Every permission check is server-side, on every request.** Hiding a button
   is not a permission.
5. **Money is `Decimal`. Never `float`.** No arithmetic on money with JS numbers.
6. **`businessDate` is computed by the server** on every transactional row. The
   client never sends it.
7. **Soft-delete anything touching money or stock.** Never hard-delete a sale,
   ledger row, batch or redemption.
8. **No `prisma db push`.** Generate a migration with `npm run db:migrate`,
   commit it. Production runs `migrate deploy` only.
9. **Guards return the `Actor`; services take it.** Page guards call
   `forbidden()` (a real 403), API guards throw `AppError`. Never check a role
   inside a component.
10. **Throw `AppError` from services**; `handleRoute` converts it. Never build
    error JSON inside a route handler.

## Decisions already made — do not reopen

| Decision | Consequence |
|---|---|
| A sale records **money only** | No `marbleCount` on `Sale` or `SalePreset`. Ever. |
| Ticket cost is **global** | `ticketCost` is on `PrizeItem`, not `ShopPrizeConfig`. |
| Tickets **never expire** | No `EXPIRE` in `TicketTxnType`. |
| Physical tickets are collected and keyed in | Award flow must prompt "tickets counted and collected?" |
| Cost entry: owner + **Purchasing** managers | `User.canEnterCost`, scoped to their own shops. |
| **Unlimited** shops and staff | Never hardcode a shop count, code or list. |
| No receipt printing in v1 | On-screen confirmation only. |
| Backups are local, copied off-machine manually | Build the export button, copy log and staleness alert. |
| **Auth is Better Auth**, not hand-rolled | §5.4 rewritten 4 Aug 2026. Never restore `passwordHash` / `Session` from §6. |
| `user.email` holds **synthetic `.invalid`** addresses | Required by the library; the business collects no email. Never wire up real email. |
| **`banned`** is the only access flag on `User` | No `isActive` column there. DTO exposes `isActive: !banned`. UI says "Deactivate", never "ban". |
| Usernames are **immutable** after creation | They seed the synthetic email. `displayName` is the mutable name. |
| The admin plugin's `adminRoles` is **not wired up** | Privileged ops use `auth.$context.internalAdapter` after our own `requireOwner()`. Not a hack — see BUILD-LOG D-4. |

## Invariants that break the business if violated

- **On-hand stock = `SUM(PrizeBatch.qtyRemaining)`.** Never add a `qtyOnHand`
  column. If performance demands a cache, use a materialised view.
- **FIFO lives in one file:** `src/server/services/inventory.ts`. Never inline
  FIFO logic into a route handler. Consumption records
  `unitCogsAtConsumption` at the moment it happens — prize expense is a sum of
  those rows, never a recomputed average.
- **Balance caches** (`Customer.marbleBalance`, `ticketBalance`) are written
  only inside the same transaction as the matching ledger insert. The ledger is
  the truth.
- **Balances and stock may never go negative.** Check inside the transaction,
  at commit time. Never trust a balance the client sent.
- **Cost fields must never reach a non-privileged session.** Build separate
  `toCostDTO()` / `toRestrictedDTO()` builders in `src/server/dto/`. The
  restricted builder physically does not read the cost columns. Do not
  implement this by deleting keys from a full object.
- **Every mutation is idempotent** against a double-tap via an
  `Idempotency-Key` header. Staff will double-tap on slow shop wifi.

## Cost visibility gate

```ts
const canSeeCost =
  user.role === "OWNER" ||
  (user.role === "MANAGER" && user.canEnterCost);
// For MANAGER, always intersect with: shopId ∈ user.assignedShopIds
```

A Purchasing manager gets cost entry and stock valuation for their own shops.
They still get `403` on profit, margin and all-shops endpoints.

## Commands

Development is **native on macOS against Homebrew PostgreSQL 16** — no Docker
in the dev loop. Docker is production only (Windows).

```bash
npm install
npm run db:migrate        # creates + applies a migration, then seeds
npm run dev

# Useful
npm run db:studio         # browse the database
npm run typecheck
npm run db:reset          # wipe and re-seed
```

`DATABASE_URL` in `.env` points at `localhost:5432/marblehouse_dev` for dev and
`postgres:5432/marblehouse` for Docker. Both lines are in the file; swap the
comment. Never edit the production `.env` from here.

## Before finishing any phase

**The phase is not done until all seven pass.** Do not report a phase complete
with any of these outstanding — say which one is unfinished and why.

1. `npm run typecheck` passes.
2. `npm run lint` passes.
3. `docker compose build` succeeds. **Run this even though dev is native** —
   macOS is case-insensitive and Linux is not, so a bad import like
   `./components/button` vs `./components/Button` only fails here. If Docker
   is not installed on this machine, say so rather than skipping the check
   silently.
4. The phase's acceptance criteria in PRD §16 demonstrably pass. Write a
   re-runnable script at `scripts/verify-phase<N>.sh` — see
   `scripts/verify-phase1.sh` for the shape — and paste its output.
5. Migrations are committed. Never generate a migration on the production box.
6. **Update `docs/BUILD-LOG.md`.** Specifically:
   - Flip this phase's row in the **Phase status** table to ✅, and the next
     phase's to ⬜ Next.
   - Add a `### D-n` entry for **every decision taken during the phase** —
     anything the owner chose between options, any ambiguity you resolved, and
     anything a later reader would mistake for a bug. Record the reasoning,
     not just the outcome.
   - Add new files/services to the "what was built" map.
   - Add anything deferred or knowingly left rough to **Known issues / debts**.
   - Update **Current database state** if seeds or test accounts changed.
7. **If the schema changed, reconcile PRD §6 against `prisma/schema.prisma`**
   so the spec keeps matching the code, and note any new divergence.

> A decision that exists only in a chat transcript is a decision the next agent
> will silently reverse. The build log is the handoff — the next session starts
> cold and reads nothing else of this conversation.
