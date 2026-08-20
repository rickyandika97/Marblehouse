# PRD — Pinball Arcade Management System

**Codename:** `marblehouse`
**Version:** 1.0
**Date:** 3 August 2026
**Owner:** Vino
**Status:** Ready for build

> **How to use this document.** This is the single source of truth for the AI coding agent. Give it this file at the start of the project and tell it to read the whole thing before writing code. Build in the phase order given in §16 — do not let the agent build everything at once. Section §17 contains the exact prompts to paste for each phase.

---

## 1. Product summary

### 1.1 The business
A chain of pinball/marble arcade shops. A customer pays a fixed amount for a quantity of marbles, plays the machines, and wins **tickets**. Tickets are exchanged for physical **prizes** held in stock at each branch. Unused marbles and unspent tickets can be **stored at the shop and used later at any branch**.

### 1.2 The problem
Everything above is currently tracked on paper or in people's heads. There is no reliable record of who is owed how many marbles or tickets, what prize stock exists where, what each prize actually cost, whether staff showed up on time, or whether a branch is profitable.

### 1.3 What we are building
A self-hosted, tablet-first web application that runs on a single machine the owner controls, serving all branches over the internet through a Cloudflare Tunnel. It records sales, holds customer marble and ticket balances centrally, manages prize inventory with real FIFO cost accounting, tracks staff attendance with photo + geolocation proof, records expenses, and reports profitability per branch.

### 1.4 Success criteria
The system is successful when, ninety days after launch:

1. 100% of sales are recorded in the app (verified by cash drawer reconciliation).
2. A customer can walk into any branch, give their phone number, and have their exact marble and ticket balance appear in under three seconds.
3. The owner can state gross profit per branch for last month without opening a spreadsheet.
4. No prize stockout occurred without a low-stock alert having fired first.
5. A full restore from backup onto a fresh machine has been rehearsed successfully at least once.

### 1.5 Explicitly out of scope for v1
- Customer-facing app, customer login, or self-service kiosk.
- Loyalty points, tiers, promotions, discounts, or vouchers.
- Payroll, salary, or commission calculation (attendance data is captured, but payroll is manual).
- Accounting software integration or tax reporting.
- Machine-level telemetry or hardware integration.
- Offline operation. **The app requires an internet connection at every branch.** See §14.4 for the risk and mitigation.

---

## 2. Glossary

| Term | Meaning |
|---|---|
| **Shop / Branch** | One physical arcade location. |
| **Marble** | The physical playing token. Sold in fixed-price bundles. |
| **Marble balance** | Marbles a customer physically handed back to the shop for safekeeping. Redeemable at any branch. |
| **Ticket** | Won by the player from a machine. Recorded to a customer's balance by staff. Redeemable for prizes at any branch. |
| **Prize** | A physical item held in branch stock, exchanged for tickets. |
| **Batch** | One delivery of a prize into one branch at one unit cost. FIFO consumes the oldest batch first. |
| **COGS** | Cost of goods sold — what the owner paid for a prize unit. **Hidden from managers and staff.** |
| **Preset** | A configured sale price point (e.g. Rp 50.000 → 50 marbles). |
| **Business day** | The reporting day, which starts at a configurable hour (default 06:00) rather than midnight, so a late-night session belongs to the day it started. |
| **Work session** | A staff member's declaration of which shop they are working at today. |
| **Opname** | Physical stock count reconciled against the system count. |

---

## 3. Users and roles

Three roles. **OWNER is a property of the user account** — an owner sees and
acts on everything, across all shops, with no shop assignment needed, and is
never also assigned to an individual shop. **MANAGER and STAFF are properties
of a shop assignment**, not the account (decided 19 Aug 2026, BUILD-LOG D-122,
reversing the original "a user has exactly one role"): a single account can
hold a different one of these two roles at each shop it is assigned to — for
example, MANAGER at Branch 1 and STAFF at Branch 2 — and its capabilities
differ per shop, not per account.

### 3.1 OWNER
One or two accounts. Sees and does everything, across all shops, with no shop assignment needed. Only role that can see COGS, create/edit user accounts, assign roles, assign shop access, and manage backups.

### 3.2 MANAGER
Held at one or more shops (§3, above — a user may hold this role at some shops and STAFF at others). At each shop where a user is MANAGER, they can act on that shop and view its reports; views reports **one shop at a time** — there is no "all shops" view for managers. Cannot see any cost figure anywhere in the product except at a shop where they hold the Purchasing permission (§7.5). Manages prize stock (receive, adjust, opname, transfer), sets ticket cost per prize, records expenses, assigns default shops for staff within their own shops, and does everything a staff member can do — all scoped to the shops where they hold this role.

### 3.3 STAFF
Held at one or more shops (§3, above). Operational only, at each shop where a user is STAFF: record a sale, deposit/withdraw marbles, deposit tickets, redeem prizes, look up a customer, clock in. Sees no money reporting beyond their own shift's sale list.

### 3.4 Permission matrix

`Y` = allowed · `—` = hidden and blocked · `own` = only their assigned shops · `1` = one shop at a time · `P` = only if the user has the **Purchasing** permission (§7.5)

The MANAGER and STAFF columns describe capability **at a shop where the user
holds that role** (§3, D-122) — a single account may read as the MANAGER row
at one shop and the STAFF row at another, simultaneously.

| Capability | OWNER | MANAGER | STAFF |
|---|:--:|:--:|:--:|
| **Sales** |
| Record a sale | Y | Y (own) | Y (own) |
| View today's sales list | Y (all) | Y (own) | Y (own shop, own entries + shop total count) |
| Void / correct a sale | Y | Y (own, same business day only) | — |
| View historical sales | Y (all) | Y (own, 1) | — |
| **Customers** |
| Look up customer by phone/name | Y | Y | Y |
| See name, phone, marble bal., ticket bal. | Y | Y | Y |
| See spend total, visit history, preferred shop, active days | Y | — | — |
| Create / edit customer | Y | Y | Y |
| Merge duplicate customers | Y | — | — |
| Delete customer | Y | — | — |
| **Marbles & tickets** |
| Deposit / withdraw marbles | Y | Y (own) | Y (own) |
| Deposit tickets | Y | Y (own) | Y (own) |
| Manual balance adjustment (correction) | Y | Y (own, capped, reason required) | — |
| **Prizes** |
| See prize name, ticket cost, qty on hand | Y | Y (own) | Y (own) |
| See COGS, batch costs, prize expense value | Y | **P only, own shops** | — |
| Create prize catalog item | Y | Y | — |
| Set ticket cost (global price — see §4.8) | Y | Y (warns + alerts owner) | — |
| Receive stock batch | Y | Y (own; **cost field only if P — see §7.5**) | — |
| Stock opname | Y | Y (own) | — |
| Transfer prize between branches | Y | Y (only between shops they are assigned to) | — |
| Approve incoming transfer | Y | Y (own, receiving shop) | — |
| Redeem prize for customer | Y | Y (own) | Y (own) |
| **Expenses** |
| Record expense | Y | Y (own) | — |
| Manage expense categories | Y | — | — |
| View expense report | Y (all) | Y (own, 1) | — |
| **Attendance** |
| Clock in | Y (optional) | Y (required) | Y (required) |
| View own attendance history | Y | Y | Y |
| View team attendance + lateness metrics | Y (all) | Y (own, 1) | — |
| Edit / excuse an attendance record | Y | — | — |
| Configure shifts | Y | Y (own) | — |
| **Reports** |
| Dashboard — all shops combined | Y | — | — |
| Dashboard — single shop | Y | Y (own, 1) | — |
| Revenue, customer, attendance reports | Y | Y (own, 1, no cost data) | — |
| Profit report (revenue − COGS − expenses) | Y | — | — |
| Export CSV | Y | Y (own, no cost columns) | — |
| **Admin** |
| Create user, set role, set shop access | Y | — | — |
| Grant / revoke the Purchasing permission | Y | — | — |
| Set staff default shop | Y | Y (own staff) | — |
| Reset a user's password | Y | Y (own staff, forces change on next login) | — |
| Create / edit shop | Y | — | — |
| Edit shop sale presets | Y | — | — |
| Run / download / restore backup | Y | — | — |
| View audit log | Y | — | — |

> **Enforcement rule (non-negotiable):** every one of these checks is enforced **server-side**, in the API layer, on every request. Hiding a button in the UI is not a permission. In particular, no API response returned to a MANAGER or STAFF session may contain a cost field, even unused — use separate response DTOs per role, not conditional rendering. See §7.5.

**Roles are not a fixed list of people.** Shops, managers and staff are all created through the UI and grow with the business — there is no configured maximum anywhere in the system. See §5.6 for the multi-shop scaling rules this implies.

---

## 4. Core business rules

These are the rules the agent must get right. Everything else is UI.

### 4.1 Money
- Currency is **IDR (Rupiah)**, displayed as `Rp 50.000`. Configurable currency code and locale in shop settings, but v1 assumes one currency across all shops.
- Store all money as Prisma `Decimal(14, 2)`. Never use JavaScript `float` for money anywhere.
- IDR is effectively whole-number; display with thousand separators and no decimals, but keep the two decimal places in storage for portability.

### 4.2 Business day and timezone
- Server timezone is fixed to `Asia/Jakarta` (configurable via `TZ` env var). All timestamps stored in UTC (`timestamptz`), rendered in local time.
- Every sale, expense, attendance record and redemption carries a `businessDate` (a `DATE`, no time). It is computed as: *if local time is before `dayStartHour` (**04:00**), the business date is yesterday; otherwise today.*
- **`dayStartHour` is a single global setting**, stored in `AppSetting` under the key `businessDayStartHour`, seeded to **`4`**. It is **not** per-shop.

> **Set to 04:00 — owner decision, 4 Aug 2026 (BUILD-LOG D-18).** Branches have
> different opening hours (mall sites versus standalone buildings), but **none
> trade past 23:59**. The cutoff's only job is to sit in a dead hour so that no
> shift is ever split across two business dates — it does **not** track opening
> times, and it must never be set per-branch to match them. 04:00 clears the
> latest close by four hours and leaves margin before early-morning setup.
>
> Per-branch opening hours belong to `Shift` (§4.14). Confusing the two is the
> mistake to avoid: the cutoff decides *which day a record is filed under*;
> shifts decide *when staff are expected and whether they are late*.
- All daily reporting groups by `businessDate`, never by raw timestamp.

> **Why global — corrected 4 Aug 2026.** This was originally specified as a
> per-shop setting, which created a circular dependency: §4.7 keys a
> `WorkSession` on `(userId, businessDate)`, but at the moment the shop picker
> appears the user has not yet chosen a shop, so there is no `dayStartHour` to
> compute the date from. For a multi-shop user whose branches had different
> cutoffs, the business date would have been undefined.
>
> Making it global removes the cause rather than papering over it. It also
> prevents a subtler bug: a work session dated by one rule while the sales
> recorded inside it are dated by another. Every branch is one business in one
> timezone, so a per-branch reporting day buys nothing.
>
> `lateGraceMin` **stays per-shop** — it can legitimately differ by branch and
> has no circularity, because an attendance record always knows its shop.

### 4.3 Sales
- A sale is a single transaction: one preset amount, one payment method, optional customer.
- Payment method is `CASH` or `EDC` (card/QRIS terminal). Extensible enum.
- Presets are **per shop**. Each shop is seeded with the defaults: `20.000 / 50.000 / 100.000 / 200.000 / 500.000`. Owner can add, edit, reorder, or deactivate presets per shop.
- **A preset is an amount and a label — nothing else.** The system does **not** record how many marbles a sale hands over. *(Decision, 3 Aug 2026: the owner only cares about cash collected. Marbles are physical; the app tracks money in, and separately tracks marbles a customer chose to store.)* Do not add a `marbleCount` field to presets or sales.
- A preset that has been used in a sale can be **deactivated but never deleted or edited in a way that changes its amount**. Editing an amount creates a *new* preset version and deactivates the old one. This keeps historical sales accurate.
- Optional "custom amount" toggle per shop (default off). When on, staff may enter a free amount; every custom sale is flagged in the audit log.
- The sale is attributed to: the **logged-in user** (`recordedByUserId`) and the **shop from their active work session** (§4.7). Neither is selectable on the sale form.
- Sales cannot be edited. They can be **voided** by an owner (any time) or a manager (same business day only), with a mandatory reason. A void creates a reversing record; the original row is never deleted.

### 4.4 Customers
- A customer is identified by **phone number**, which is unique and is the login-free lookup key. Normalize to E.164-ish on save (strip spaces/dashes, convert leading `0` to `+62`), store both `phoneRaw` and `phoneNormalized`.
- Name is required only when a phone number is given. A sale with no customer is recorded as `customerId = null` and labelled **Walk-in**.
- **Walk-ins cannot store marbles or tickets.** If staff try to deposit for a walk-in, the app prompts to capture a phone number first. This is the single reason the phone number matters — say so in the UI copy.
- Duplicate handling: phone number uniqueness prevents most duplicates. Owner has a merge tool that moves all ledger entries, sales and redemptions from a losing record to a winning one inside one transaction, then soft-deletes the loser.

### 4.5 Marble balances
- The sale records **money only** (§4.3). Marbles are handed over physically and are not counted by the system at point of sale.
- The marble balance therefore represents exactly one thing: **marbles a customer physically handed back to the counter for safekeeping.** There is no derived or expected balance to reconcile against, which is what makes this simple.
- The balance changes only through explicit ledger events:
  - `DEPOSIT` (+) — customer hands unused marbles back to the counter.
  - `WITHDRAW` (−) — customer takes stored marbles back to play.
  - `ADJUST` (±) — correction, reason mandatory, owner/manager only.
  - `TRANSFER_NOTE` — not a balance change; informational only if ever needed.
- Balance is **append-only ledger + a cached `marbleBalance` column** on `Customer`, updated inside the same database transaction as the ledger insert. The cached column is a performance convenience; the ledger is the truth. A nightly job recomputes the cache from the ledger and logs any drift as a critical alert.
- Balance may never go negative. Attempting a withdraw greater than the balance is rejected server-side with a clear error.
- Balances are **global across all branches** — a deposit at Branch A is withdrawable at Branch C. Record `shopId` on every ledger row anyway, for reporting on where liability was created versus settled.

### 4.6 Tickets
- Same ledger design as marbles, separate table and separate cached column `ticketBalance`.
- Event types: `AWARD` (+, staff records tickets a player won), `REDEEM` (−, automatic from a redemption), `ADJUST` (±, reason mandatory), `VOID_RESTORE` (+, from a voided redemption). **Tickets never expire in v1** — there is deliberately no `EXPIRE` type in the enum; adding one later is a migration plus a policy decision, not a code shortcut.
- Awarding tickets requires a customer. Tickets cannot be awarded to a walk-in.

**Physical ticket handling (decided).** Machines dispense physical tickets; staff collect them and key the count into the app.

- **The physical tickets must be destroyed or dropped into a locked one-way bin at the moment of entry.** If a customer walks away still holding tickets that are also credited in the app, the same win can be redeemed twice. Write this into the staff SOP and put the reminder in the award confirmation dialog: *"Tickets counted and collected?"*
- Because the count is typed by a human with no machine cross-check, **ticket awards are the weakest control in the system.** Build these three safeguards in Phase 3:
  1. Every `AWARD` row records the staff member and shop (already in the schema).
  2. A **Tickets Awarded by Staff** report: tickets awarded per staff per day, and tickets awarded per rupiah of sales at that shop that day. A staff member quietly inflating awards for friends shows up as an outlier on that ratio.
  3. An owner-configurable **single-award threshold** (default 500 tickets) above which the app requires a reason note. Not a block — just a paper trail.
- Optional later: a bin-count reconciliation, where the physical tickets in the bin are weighed or counted weekly and compared to the total awarded. Out of scope for v1, but the data supports it.
- Cannot go negative. Redemption checks balance server-side at the moment of commit, inside the transaction — never trust a balance the client sent.
- Tickets are **global across branches**, like marbles.

> **Owner note — this is a real liability.** Outstanding marbles and tickets are money you have already collected but not yet delivered value for. The dashboard must show total outstanding marbles and total outstanding tickets, and the profit report must show estimated ticket liability (outstanding tickets × blended COGS per ticket) as a memo line. Ignoring it will make early months look more profitable than they are.

### 4.7 Work session (which shop am I at today?)
- On the **first login of each business day**, the user is shown a full-screen, non-dismissible shop picker. Their `defaultShopId` is pre-selected and listed first; only shops they are assigned to are listed. Owner sees all shops.
- The selection creates a `WorkSession` row for `(userId, businessDate)` and drives the `shopId` on every record they create that day.
- On later logins the same day, no prompt — the existing work session is reused.
- The user can change the shop from **Settings → Current shop** at any time. Changing it:
  - does **not** retroactively move records already created that day;
  - writes an audit log entry with old shop, new shop, timestamp and reason;
  - requires a reason if any records were already created under the old shop that day.
- If a user has exactly one assigned shop, auto-select it and skip the prompt.

### 4.8 Prizes, stock and FIFO
- The prize catalog is **global** (`PrizeItem`: name, category, image, active, **ticketCost**).
- **Ticket cost is global — one price for a prize across every branch.** *(Decision, 3 Aug 2026.)* There is no per-branch price override. A customer who visits three branches sees one consistent price.
- Stock is **per shop**, held in batches.
- Per-shop configuration (`ShopPrizeConfig`) now holds only `lowStockThreshold` and `isActive` — whether this branch carries the item at all, and when to warn. Both are legitimately branch-specific.
- **Consequence to be aware of:** because ticket cost is global, a manager editing it changes the price at branches they do not manage. The app therefore shows a warning on that field (*"This price applies to all branches"*), audit-logs every change with old and new value, and raises an owner alert on the dashboard. If you would rather managers could not touch it at all, flip the `MANAGER can set ticket cost` row in §3.4 to `—`; the code path is a single permission check.
- All stock lives in **batches** (`PrizeBatch`), one row per delivery into one shop: `qtyReceived`, `qtyRemaining`, `unitCogs`, `receivedAt`, `supplier`, `batchCode`.
- **Quantity on hand for a prize at a shop = `SUM(qtyRemaining)` of its non-void batches at that shop.** There is no separate quantity column to drift out of sync.
- **FIFO consumption:** any stock-decreasing event (redemption, transfer out, negative opname variance, damage) consumes batches ordered by `receivedAt ASC, id ASC`, splitting across batches as needed. Each consumption writes `StockConsumption` rows recording `batchId`, `qty`, and `unitCogs` **at the moment of consumption**. Prize expense is the sum of `qty × unitCogs` over those rows — never a recomputed average.
- **Low stock:** when on-hand ≤ `lowStockThreshold`, the prize is flagged. Threshold `0` means no alert. Flags surface on the owner dashboard, the manager's shop dashboard, and a dedicated Low Stock report.
- Stock can never go negative. Redemption of an item with insufficient stock is rejected at commit time inside the transaction.

### 4.9 Redemption
- Staff opens a customer, taps **Redeem**, and sees only prizes that are: active, configured at *their current shop*, and have on-hand qty ≥ 1.
- Prizes the customer cannot yet afford are shown greyed out with "needs N more tickets" — visible but not selectable. (Motivates the customer; do not hide them.)
- Redemption is a **cart**: multiple prizes, multiple quantities, one checkout.
- On checkout, in a single database transaction:
  1. Lock the customer row; re-read ticket balance.
  2. Compute total ticket cost from the **server's** current `ticketCost` values, not the client's.
  3. Reject if balance < total, or if any line exceeds on-hand stock.
  4. Insert `Redemption` + `RedemptionLine` rows.
  5. Consume batches FIFO, insert `StockConsumption` rows, decrement `qtyRemaining`.
  6. Insert a `TicketLedger` `REDEEM` row and update the cached balance.
  7. Insert `StockMovement` rows of type `REDEEM`.
- Redemption can be **voided** by an owner within 24 hours. A void restores tickets and returns quantity to the exact batches it came from (using the `StockConsumption` rows). After 24 hours, an owner must use a manual stock adjustment plus a ticket adjustment, both with reasons.

### 4.10 Prize transfer between branches
- Two-step by default, because physical movement takes time and single-step transfers make both branches' counts wrong while the box is in the car.
  1. **Dispatch** — source shop selects prize + quantity. FIFO batches are consumed at source immediately. Transfer status becomes `IN_TRANSIT`. Stock is now in neither branch's on-hand count; it appears in an "In transit" figure.
  2. **Receive** — destination shop confirms. New `PrizeBatch` rows are created at the destination, **one per source batch consumed**, preserving the original `unitCogs` and the original `receivedAt`. Status becomes `RECEIVED`.
- Preserving `receivedAt` matters: it keeps FIFO order globally honest, so an old cheap batch that moved branches still gets consumed before a new expensive one.
- A transfer can be `CANCELLED` while `IN_TRANSIT`; the batches are restored at the source.
- Shop setting `allowDirectTransfer` (default off) collapses both steps for same-day, same-person moves.
- A manager may only create a transfer where **both** shops are in their assignment list. Cross-region moves are owner-only.

### 4.11 Stock opname (physical count)
- Manager or owner selects a shop and enters counted quantities per prize. System shows system quantity only **after** the count is entered, to prevent anchoring.
- Variance handling:
  - **Negative variance (shrinkage):** consume FIFO, write `StockConsumption` rows, categorise as `OPNAME_LOSS`. This flows into an expense line the owner can see, separate from prize expense.
  - **Positive variance (found stock):** create an adjustment batch at the current weighted-average unit cost of that prize at that shop, flagged `isAdjustment = true`.
- Every opname is saved as a session with a timestamp, the user, line-by-line variance, and an optional note. Owner sees a variance-value report; manager sees variance quantity only.

### 4.12 Expenses
- Fields: shop, category, amount, `businessDate`, notes (free text, optional), recorded by, optional receipt photo.
- Categories are managed by the owner. A category may be **deleted only if it has zero expense rows**; otherwise it can only be **archived** (hidden from new entries, preserved in history). The API returns a clear 409 with the usage count when a delete is refused.
- Seed categories: Electricity, Rent, Water, Internet, Salary, Machine Maintenance, Supplies, Marketing, Transport, Other.
- Expenses are shop-scoped. An "HQ / unallocated" pseudo-shop is created so the owner can record non-branch costs; it accepts no sales.

### 4.13 Attendance
- **Required for STAFF and MANAGER. Optional for OWNER.**
- Flow: log in → pick shop (§4.7) → **big red banner appears** → user can work normally → user taps banner → clock-in → banner disappears for the rest of the business day.
- The banner is fixed to the top of the viewport, high-contrast red, present on every screen, and **not dismissible**. It reads: *"You have not clocked in today. Tap here to clock in."*
- Clock-in requires, in order:
  1. **Shift selection** — the shifts configured for that shop (§4.14).
  2. **Photo** — captured live from the device camera via `getUserMedia`. **File upload from the gallery is blocked** (`capture="user"` plus a server-side check that the image has no EXIF suggesting an older capture date; reject if EXIF `DateTimeOriginal` is more than 10 minutes old).
  3. **Geolocation** — requested via the browser Geolocation API at the moment of capture.
- The server (never the client) burns a watermark into the saved image: date, time, timezone, shop name, user name, latitude/longitude, and accuracy in metres. The original is discarded; only the watermarked version is stored.
- If the user denies location permission, clock-in still proceeds but the record is flagged `locationDenied = true`, the watermark says `LOCATION UNAVAILABLE`, and the record appears highlighted in the owner's attendance report.
- **Lateness:** `isLate = clockInAt > shiftStart + gracePeriod`. Grace period is **5 minutes**, configurable per shop. `lateMinutes` is stored as an integer for reporting.
- Clock-out is captured (photo optional, configurable per shop) but lateness reporting in v1 is based on clock-in only.
- **One attendance record per user per business day** (enforced by a unique constraint on `userId + businessDate`). A second clock-in on the same day is blocked with a friendly message. A user cannot clock in at two shops on the same day — if they genuinely move branches mid-day, the owner edits the record.
- Owner can edit or excuse a record (e.g. approved late arrival). Every edit is audit-logged with before/after values.

### 4.14 Shifts
- Per shop, a list of shifts: `name`, `startTime`, `endTime` (both `TIME`), `isActive`, `daysOfWeek` (bitmask or array; default all days).
- Shifts may cross midnight (`endTime < startTime`); handle explicitly.
- Editing a shift's times does **not** retroactively change past lateness — attendance records store a snapshot of `shiftStartAtCapture` so historical lateness stays correct.

### 4.14.1 The staff timetable (roster)
- §4.14's `Shift` says when a **shop** is open. This says which **person** is
  expected on which shift on which day. The two are separate on purpose: a shop
  runs a Morning shift every day, but Budi only works it Mon–Wed.
- Two layers, composed at read time — never merged into storage:
  - **`ScheduleAssignment`** — the recurring pattern. One row = "this person,
    this shift, these weekdays". It repeats until removed. `effectiveFrom` is
    stored (defaulted to the day it was created, **never entered by hand**) so
    "was this person scheduled last Monday?" stays answerable; there is
    deliberately **no `effectiveTo`** — an end date was a second way of saying
    "this has stopped" and could disagree with removal.
  - **`ScheduleOverride`** — a single-date exception, `ADDED` or `REMOVED`,
    always with a **reason**. Leave, a swap, an extra body on a busy Saturday.
- **An override never edits the pattern.** Changing next Tuesday must not change
  every Tuesday. The resolver applies overrides on top of the pattern for the
  one date asked about.
- `REMOVED` is keyed on **(user, shift, date)**, not (user, date). Someone off
  the morning is still on the evening; a whole day's leave is two rows.
- **An assignment's `daysOfWeek` is intersected with its shift's, never
  unioned.** A person cannot be rostered on a day the branch does not run that
  shift, and retiring a shift or dropping one of its days immediately stops
  rostering against it.
- **Removing an assignment is a SOFT delete** (`removedAt`). It disappears from
  the roster, from `resolveDay` and from the clock-in prompt, but the row
  survives. `Attendance` has no foreign key to it, so a hard delete would break
  nothing structurally — what it would destroy is the evidence behind a past
  record: an attendance row reading `SCHEDULED, 440 minutes late` only means
  something while the schedule that put that person on a 10:00 shift can still
  be read. That is a wage conversation (§4.13). A removal can be restored.
- A person must already hold a `UserShop` row at the branch before they can be
  rostered there, and a deactivated employee never resolves onto a roster.
- **Who may edit:** owner, or a MANAGER at that shop — the same delegation §3.4
  gives shift configuration. STAFF are refused the screen outright.

### 4.14.2 Leave
- A **date range** of approved absence: `userId`, optional `shopId`,
  `startDate`, `endDate` (both **inclusive**), and a required `reason`.
- One row covers the whole period. A fortnight's holiday is one record, not
  fourteen — leave is granted as a period, and it **ends by itself**: the
  person's recurring schedule resumes with nothing to switch back on.
- **`shopId` is null by default**, meaning every branch this person works at.
  Somebody on holiday is away from the business, not from one site. A value
  scopes it to one branch for the rarer case.
- **Leave is applied last in `resolveDay`, after overrides.** Approved leave
  beats an `ADDED` override: to bring somebody in during their leave you cancel
  the leave — which leaves a record — rather than layering an override on top,
  which would not.
- **Leave suppresses the clock-in prompt and lateness. It never BLOCKS a
  clock-in.** Somebody on leave who comes in to cover a sick colleague can still
  record their attendance by giving a reason, exactly as unscheduled staff do
  (§4.14.1). A branch must never be unable to record somebody standing in it.
- Leave is **not** the same as removing a schedule. Leave is temporary and
  self-reversing; removal is for a person who no longer works that shift.

**Effect on clock-in (§4.13).**
- The red banner is no longer unconditional for every non-owner. It appears only
  when the roster **expects this person at this branch today** — `prompt` in
  `GET /api/attendance/status`. A staff member is not nagged on their day off.
- **Settings carries a clock-in row** for every non-owner, since the banner no
  longer fires for people the roster does not expect. It shows what it will
  actually do: "you are scheduled today", "covering a shift you are not rostered
  for", or the time they already clocked in at. Without it, the people most
  likely to need the cover flow have no route to it.
- **Being unscheduled never blocks a clock-in.** Someone covering at short
  notice can still clock in; they must give a **reason**, and the record is
  stored with `scheduleSource = COVER` plus `coverReason` so the owner can see
  why that shift was worked. Blocking would mean a branch cannot open because
  nobody updated the roster.
- **A branch with no roster at all behaves exactly as it did before this
  section existed** — no cover prompt, `scheduleSource = SCHEDULED`. Every shop
  that predates the timetable, and every new branch on its first day, is in this
  state; gating them would make the feature an obstacle to opening the shop and
  train everyone to type "n/a" into the reason field.

### 4.15 Attendance photo retention
- Photos are retained **61 days**. A nightly job deletes photo files whose `capturedAt` business date is older than 61 days, then nulls the `photoPath` and sets `photoPurgedAt` on the record.
- **The attendance record itself is kept forever** — only the image is removed. Lateness history must survive.
- Photos are stored on disk under `/data/attendance/YYYY/MM/DD/<uuid>.jpg`, **never as bytes in Postgres** (it would bloat every backup). The backup job archives the photo directory separately (§13).
- Photos are served only through an authenticated route that re-checks role and shop access. No public static serving of `/data`.

### 4.16 Audit log
Every one of the following writes an immutable audit row (actor, role, shop, entity, entityId, action, before JSON, after JSON, IP, timestamp):
sale void · manual marble adjust · manual ticket adjust · redemption void · stock adjust · opname commit · transfer dispatch/receive/cancel · ticket cost change · preset change · user create/role change/shop-access change/password reset · attendance edit · expense delete · shop setting change · backup restore.

Audit rows are never editable or deletable through the application.

---

## 5. Architecture and tech stack

### 5.1 Deployment topology (decided)

**One central server. All branches connect to it over the internet.**

```
   Branch A tablet ┐
   Branch B tablet ├─► https://arcade.yourdomain.com
   Branch C tablet ┘              │
                                  ▼
                    Cloudflare edge (TLS, DDoS, WAF)
                                  │  outbound-only tunnel
                                  ▼
        ┌───────────────────────────────────────────┐
        │  Your Windows machine (Docker Desktop)    │
        │                                           │
        │  ┌──────────┐  ┌──────────┐  ┌─────────┐  │
        │  │cloudflared│─►│  app     │─►│ postgres│  │
        │  │  tunnel   │  │ Next.js  │  │   16    │  │
        │  └──────────┘  └────┬─────┘  └────┬────┘  │
        │                     │             │       │
        │              ./data (photos)  ./pgdata    │
        │                     │             │       │
        │              ┌──────▼─────────────▼─────┐ │
        │              │ backup job (2am, 7 days) │ │
        │              └──────────┬───────────────┘ │
        └─────────────────────────┼─────────────────┘
                                  ▼
                    Off-machine copy (see §13.4 — mandatory)
```

**Why this shape:** marble and ticket balances are shared across branches, so they need one authoritative database. Per-branch servers with sync would require conflict resolution on customer balances, which is the hardest possible thing to vibe code and the easiest to get subtly, expensively wrong.

**No inbound ports are opened.** `cloudflared` makes an outbound connection to Cloudflare; traffic flows back down that tunnel. This is why no router configuration, static IP, or port forwarding is needed.

### 5.2 Stack (decided — do not substitute)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Node.js 22 LTS** | |
| Framework | **Next.js 15, App Router, `output: 'standalone'`** | Self-hosted with `next start` in Docker. **No Vercel.** Nothing in this project may use Vercel-only APIs (`@vercel/*`, edge runtime, ISR-on-CDN, Vercel Blob/KV/Postgres). |
| Language | **TypeScript, `strict: true`** | |
| Database | **PostgreSQL 16** | In Docker, data on a bind-mounted volume. |
| ORM | **Prisma 6** | `prisma migrate` for schema; **never** `db push` outside local dev. |
| Auth | **Custom credentials + DB-backed sessions** | See §5.4. No OAuth, no third-party auth service. |
| Validation | **Zod** | One schema per endpoint, shared between client form and server handler. |
| Server logic | **Next.js Route Handlers** (`app/api/**/route.ts`) | Plain REST + JSON. Avoid Server Actions for mutations — explicit endpoints are easier to test, log and debug. |
| UI | **React 19 + Tailwind CSS + shadcn/ui on Base UI** | shadcn is a **code generator, not a dependency** — `npx shadcn@latest init` copies component source into `src/components/ui/` and you own the files. Add components as each phase needs them; never bulk-add the catalogue. |
| UI primitives | **Base UI (`@base-ui/react`)** | shadcn's default since 3 July 2026. **Do not mix in `@radix-ui/*`** — one primitive library only. See §5.7. |
| Data fetching | **TanStack Query** | Gives you caching, retry, and optimistic updates cheaply. |
| Tables/charts | **TanStack Table + Recharts** | |
| Image processing | **sharp** | Watermarking. Works on arm64; see §12.3. |
| Jobs | **node-cron inside the app container** | Only 4 jobs; a separate scheduler is overkill. Guard with a DB advisory lock so a double-start can't double-run. |
| Logging | **pino** → stdout → Docker json-file driver, rotated | |
| Tunnel | **cloudflared** named tunnel, in Docker | |

### 5.3 Repository layout

```
marblehouse/
├─ docker-compose.yml
├─ docker-compose.pi.yml          # arm64 overrides
├─ .env.example
├─ Dockerfile
├─ prisma/
│  ├─ schema.prisma
│  ├─ migrations/
│  └─ seed.ts
├─ scripts/
│  ├─ backup.sh
│  ├─ restore.sh
│  └─ healthcheck.sh
├─ src/
│  ├─ app/
│  │  ├─ (auth)/login/
│  │  ├─ (app)/                   # authenticated shell: nav, red banner, shop context
│  │  │  ├─ dashboard/
│  │  │  ├─ sale/
│  │  │  ├─ customers/
│  │  │  ├─ prizes/
│  │  │  ├─ expenses/
│  │  │  ├─ attendance/
│  │  │  ├─ reports/
│  │  │  └─ settings/
│  │  └─ api/
│  ├─ server/
│  │  ├─ auth/                    # session, password hashing, guards
│  │  ├─ services/                # ALL business logic lives here
│  │  │  ├─ sales.ts
│  │  │  ├─ marbles.ts
│  │  │  ├─ tickets.ts
│  │  │  ├─ inventory.ts          # FIFO engine — most important file
│  │  │  ├─ redemption.ts
│  │  │  ├─ transfers.ts
│  │  │  ├─ attendance.ts
│  │  │  ├─ expenses.ts
│  │  │  └─ reports.ts
│  │  ├─ dto/                     # role-shaped response builders (COGS stripping)
│  │  ├─ jobs/
│  │  └─ audit.ts
│  ├─ components/
│  ├─ lib/                        # money, businessDate, phone normalisation
│  └─ types/
├─ data/                          # bind-mounted: attendance photos, receipts
└─ backups/
```

**Rule for the agent:** route handlers do three things only — authenticate, validate with Zod, call a service. All business logic and all Prisma transactions live in `src/server/services/`. This is what keeps the codebase workable once it is 15k lines.

### 5.4 Authentication and session — Better Auth, decided 4 Aug 2026

**Use [Better Auth](https://better-auth.com) with the Prisma adapter.** It is a
library that runs inside this app against our own Postgres — not a hosted
service — so it does not breach the self-hosting constraint. The original spec
called for hand-rolled sessions; that was a mistake. Authentication is where
subtle security bugs live (timing-safe token comparison, session fixation,
cookie flags, rotation, throttling), and a maintained library gets those right
by default. The owner already uses Better Auth on another project, so the
patterns will be familiar.

**Configuration:**

- **`username` plugin** — staff have no work email, so username is the login
  identifier. Unique, case-insensitive. Email is not collected at all.
- **`admin` plugin** — gives owner-side user management, password setting, and
  ban/unban (which backs our `isActive` flag). Impersonation is useful for
  supporting a confused staff member; if enabled it **must** be audit-logged.
- **Password hashing: argon2id** (`@node-rs/argon2`) configured explicitly.
  Minimum 8 characters, blocklist the 100 most common passwords.
- **Session:** `HttpOnly; Secure; SameSite=Lax` cookie, **rolling 12-hour
  expiry** — long enough for a shift, short enough that a tablet left at a shop
  overnight logs out.
- **Rate limiting:** Better Auth's built-in limiter, tuned to 5 failed attempts
  per username per 15 minutes → 15-minute lockout, written to the audit log.
- **No email flows.** No verification, no magic links, no email password reset
  — there are no email addresses. A forgotten password is reset by an owner or
  manager via the admin plugin, which sets `mustChangePassword`.

**The email column — synthetic addresses (decided 4 Aug 2026).** Better Auth's
core user model requires a non-null, unique `email`, which collides with "no
email addresses exist". Reconciled as follows:

- At user creation the server generates
  **`${username.toLowerCase()}@marblehouse.invalid`**.
- **`.invalid` is deliberate.** It is reserved by RFC 2606 and is guaranteed
  never to resolve. Do **not** use `.local` — that is mDNS (RFC 6762) and can
  resolve on a real network, which is the exact surprise this avoids.
- Usernames are unique and case-insensitive, so the generated addresses are
  unique without extra work.
- The address is **never shown in the UI and never editable.** It is an
  internal key, not contact information. Annotate the generation site so a
  future reader does not "fix" it by wiring up real email.
- Every email-sending path stays disabled. If one ever fires, `.invalid`
  produces a hard failure rather than mail reaching a real inbox.
- **Usernames are immutable after creation**; `displayName` is the mutable
  human-facing field. This removes the need to keep username and synthetic
  email in sync — a class of bug with no offsetting benefit. A genuine rename
  is: owner deactivates the account and creates a new one.
- Do **not** make the column nullable. Patching around a library's own lookups
  breaks at the next upgrade.

**User deactivation — `banned`, not `isActive` (decided 4 Aug 2026).** The
admin plugin's `banned` flag is the **single stored source of truth** for
whether a user may access the system. There is no `isActive` column on the user
table.

- Better Auth enforces `banned` **at the session layer** — banning revokes
  existing sessions and refuses login. A hand-checked `isActive` column would be
  enforced only where someone remembered to check it, so a deactivated staff
  member would keep working until their session expired.
- The user DTO exposes a derived **`isActive: !banned`** for the UI. Derived,
  never stored.
- **UI copy is "Deactivate" / "Reactivate" / "Deactivated" — never "ban".** Most
  deactivations are someone leaving the job, not misconduct. `banned` is an
  implementation detail and must not surface in the interface.
- `banReason` records why. Every deactivation and reactivation is audit-logged
  (§4.16). `banExpires` provides temporary suspension; no UI for it in v1, but
  do not design it out.
- **Scope: `User` only.** `isActive` on `Shop`, `Customer`, `PrizeItem` and
  `ShopPrizeConfig` is unrelated to authentication and stays exactly as
  specified in §6.
- Deactivation never deletes or orphans history. A deactivated staff member's
  sales, ledger entries and attendance remain intact and still attribute to
  them by name in historical reports.

**Schema reconciliation — get this right in Phase 1:**

Better Auth owns the `user`, `session`, `account` and `verification` tables and
generates them via its CLI. Our domain fields ride along:

> **Done in Phase 1.** The reconciliation described here is complete and §6 now
> shows the result. `prisma/schema.prisma` is the authority; regenerate the
> auth-owned columns with the Better Auth CLI and reconcile by hand.

- `role`, `canEnterCost`, `defaultShopId`, `mustChangePassword`, `displayName`
  and `phone` are declared through Better Auth's **`user.additionalFields`**,
  not as a parallel table. A second table joined to the auth user would be a
  permanent source of drift. **Every field the app writes must be declared
  there** — the library silently strips undeclared keys from a create payload.
- The hand-rolled `Session` model and the `passwordHash`, `failedLoginCount`
  and `lockedUntil` fields are gone from `User`. Better Auth provides all of
  them; the password hash lives on `Account.password`.
- All domain relations (`UserShop`, `Sale.recordedBy`, `Attendance.user`,
  `AuditLog.user`, ledger rows) point at Better Auth's user table. The Prisma
  model stays named `User` via `@@map("user")` so the rest of this document
  still reads correctly.
- **Known rough edge:** TypeScript inference for `additionalFields` is
  imperfect. Do not work around it by casting to `any` — write the type. On the
  server this is `AuthUserFields` in `src/server/auth/session.ts`, asserted in
  exactly one place; on a client, use the `inferAdditionalFields` plugin.
- **The admin plugin's `adminRoles` is deliberately NOT wired to our roles.**
  It has its own access-control map, and registering `OWNER` there would create
  a second source of truth for permissions. Consequence: `auth.api.createUser`
  and `auth.api.setUserPassword` are plugin-gated and return 403 for us, so
  privileged operations go through `auth.$context.internalAdapter` **after**
  our own `requireOwner()` has authorised them. This is intentional; replacing
  it with the `auth.api.*` calls breaks user creation in production.

**Unchanged, and still mandatory:** on every request, middleware loads session,
user, role, shop assignments and today's work session into a request-scoped
context. Every service function receives that context. **No service function
may query the database without knowing the actor.** Better Auth supplies the
session; the shop-scoping and role logic remain ours and are still enforced
server-side on every request.

**Optional hardening (recommended):** put **Cloudflare Access** in front of the
hostname with a one-time-PIN email policy for the owner, or an IP allowlist for
branch locations, so a stranger who guesses the URL never reaches the login
page. Dashboard setting, not code.

### 5.5 Non-functional requirements

| # | Requirement |
|---|---|
| NF-1 | Sale recording completes in under 2 seconds on a mid-range tablet over 4G. |
| NF-2 | Customer lookup by phone returns in under 500 ms with 50.000 customers. |
| NF-3 | The app is usable one-handed on a 10" tablet in portrait and landscape; every primary action target is at least 44 × 44 px. |
| NF-4 | All list screens paginate (50 rows) — no unbounded queries. |
| NF-5 | Every mutation endpoint is idempotent against double-tap: client sends a UUID `Idempotency-Key`; the server stores it for 24 h and returns the original result on replay. **This matters — staff will double-tap on a laggy connection and you will get duplicate sales.** |
| NF-6 | Runs in under 2 GB RAM total (app + Postgres) so a Raspberry Pi 5 with 4 GB is viable. |
| NF-7 | Zero data loss on ungraceful shutdown: Postgres `fsync=on`, all multi-step writes in transactions. |
| NF-8 | The whole system starts from `docker compose up -d` with no manual steps beyond editing `.env`. |
| NF-9 | No hardcoded limit on shops, users, customers, or prizes. Adding branch number 12 requires no code change and no migration. |

### 5.7 UI primitive layer — Base UI, decided 4 Aug 2026

The headless layer under every component is **Base UI**. Radix is not used.

Why, briefly:

- shadcn made Base UI its default on **3 July 2026**; `npx shadcn init` now generates Base UI components unless you explicitly pass `-b radix`. Fighting the generator's default on every `shadcn add` for ten phases is a tax with no payoff.
- Base UI has been stable since **v1.0 in December 2025**, is at 1.6.0 with over 6M weekly downloads, and is maintained full-time by the engineers who originally built Radix Primitives, now at MUI.
- Radix was acquired by WorkOS and its update velocity has slowed on the complex components — **Combobox and multi-select in particular**, which is precisely what the customer phone-lookup and redemption cart screens depend on.

Radix is not deprecated and shadcn still ships both. This is a consistency decision, not a quality judgement.

**Rules:**

1. **One primitive library.** No `@radix-ui/*` package may appear in `package.json`. If a component needs a primitive Base UI lacks, raise it rather than quietly adding Radix alongside.
2. The `shadcn` CLI belongs in `devDependencies` or is run via `npx` — it is never a runtime dependency.
3. Generated components in `src/components/ui/` are **ours**. Edit them freely; they are not vendor code and are not overwritten by updates.

### 5.6 Growth rules (unlimited shops and staff)

*(Decision, 3 Aug 2026: branch and headcount grow indefinitely; nothing may assume a fixed number.)*

- **Never hardcode a shop count, shop code, or shop list anywhere** — not in seeds, not in enums, not in report layouts, not in test fixtures.
- **Every shop-dimensioned UI must degrade gracefully as the list grows.** Concretely: the day-start shop picker and every shop selector switch from a tile grid to a **searchable list once the user has more than 8 shops**. Build the search from the start; it costs ten minutes now and is a rewrite later.
- **The owner's all-shop dashboard must stay readable at 20 branches.** Charts that plot one series per shop become unreadable past roughly eight, so: the "revenue by shop" chart shows the **top 8 by revenue plus an "Others" bucket**, with a link to the full sortable table. Do not render one line per shop on a time series.
- **All shop-scoped queries filter in SQL, never in JavaScript.** No `findMany()` then `.filter()`. This is the difference between the app staying fast at 30 branches and falling over.
- **Adding a branch is a self-service flow**, not a database task. Settings → Shops → New shop collects name, code, address, timezone, late-grace minutes, and then **clones sale presets and shifts from an existing shop** as a starting point. (Day-start hour is not here — it is global, §4.2.) Without the clone step, opening a branch means twenty minutes of tedious re-entry and someone will skip it.
- **Deactivating a shop** sets `isActive = false`; it never deletes. History, stock and ledgers stay intact and the shop disappears from pickers. Remaining stock must be transferred out first — the app blocks deactivation while `SUM(qtyRemaining) > 0` and tells you what is left.
- **Capacity planning:** on the target hardware this design comfortably handles roughly 30 branches and a few million sale rows. Past that, the first things to add are table partitioning on `Sale` by `businessDate` and a read replica for reports. You are unlikely to reach that, but the schema is already shaped for it.

---

## 6. Data model (Prisma 6)

This is the target schema. The agent should create it as `prisma/schema.prisma` and generate the initial migration. Field names are normative — the rest of this document refers to them.

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─────────────────────────────── ENUMS ───────────────────────────────

enum Role {
  OWNER
  MANAGER
  STAFF
}

enum PaymentMethod {
  CASH
  EDC
}

enum SaleStatus {
  COMPLETED
  VOIDED
}

enum MarbleTxnType {
  DEPOSIT
  WITHDRAW
  ADJUST
}

enum TicketTxnType {
  AWARD
  REDEEM
  ADJUST
  VOID_RESTORE
}

enum StockMovementType {
  RECEIVE
  REDEEM
  TRANSFER_OUT
  TRANSFER_IN
  OPNAME_LOSS
  OPNAME_GAIN
  DAMAGE
  MANUAL_ADJUST
  VOID_RESTORE
}

enum TransferStatus {
  IN_TRANSIT
  RECEIVED
  CANCELLED
}

enum AttendanceStatus {
  PRESENT
  LATE
  EXCUSED
  ABSENT
}

/// §4.14.1 — why a person was at a shop that day.
enum ScheduleSource {
  SCHEDULED   // on the roster, OR the branch has no roster at all
  COVER       // not rostered; a reason is required
  MANUAL      // entered after the fact by a manager or the owner
}

/// §4.14.1 — a per-date exception, additive or subtractive against the pattern.
enum ScheduleOverrideKind {
  ADDED
  REMOVED
}

// ─────────────────────────────── ORG ───────────────────────────────
//
// The auth-owned models below (`User`, `Session`, `Account`, `Verification`)
// were RECONCILED WITH BETTER AUTH in Phase 1 and now match what was actually
// built. See §5.4 for the decision and docs/BUILD-LOG.md for the reasoning
// behind each field.
//
// Regenerate the auth-owned columns with:
//   npx @better-auth/cli generate --config src/server/auth/auth.ts
// then reconcile by hand — the CLI does not know about our domain relations
// and will omit them.

model Shop {
  id            String   @id @default(cuid())
  code          String   @unique              // "BR-A"
  name          String
  address       String?
  phone         String?
  timezone      String   @default("Asia/Jakarta")
  // NO dayStartHour here — the business-day boundary is global, held in
  // AppSetting["businessDayStartHour"]. See §4.2 for why.
  lateGraceMin  Int      @default(5)          // per-shop; attendance always knows its shop
  allowCustomAmount    Boolean @default(false)
  allowDirectTransfer  Boolean @default(false)
  requireClockOutPhoto Boolean @default(false)
  isHqPseudoShop Boolean @default(false)      // expense-only, no sales
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  userShops     UserShop[]
  defaultForUsers User[]      @relation("DefaultShop")
  presets       SalePreset[]
  sales         Sale[]
  shifts        Shift[]
  attendances   Attendance[]
  expenses      Expense[]
  prizeConfigs  ShopPrizeConfig[]
  batches       PrizeBatch[]
  redemptions   Redemption[]
  movements     StockMovement[]
  workSessions  WorkSession[]
  marbleTxns    MarbleLedger[]
  ticketTxns    TicketLedger[]
  transfersOut  PrizeTransfer[] @relation("TransferFrom")
  transfersIn   PrizeTransfer[] @relation("TransferTo")
  opnames       OpnameSession[]

  @@index([isActive])
}

/// Owned by Better Auth (§5.4), mapped to the `user` table. Our domain fields
/// ride along via `user.additionalFields` — never a parallel profile table,
/// which would be a permanent source of drift.
model User {
  id String @id @default(cuid())

  // ── Better Auth core ──────────────────────────────────────────────
  /// SYNTHETIC, and must stay that way. Better Auth structurally requires a
  /// unique non-null email; this business collects none (§5.4). User creation
  /// generates `<username>@marblehouse.invalid`. `.invalid` is reserved by
  /// RFC 2606 and can never resolve, so a mistakenly-enabled email path fails
  /// hard instead of mailing a real stranger.
  /// Never displayed, never editable, absent from every DTO.
  /// DO NOT wire up real email — no verification, no reset, no magic links.
  email         String  @unique
  emailVerified Boolean @default(false)
  /// Better Auth's core display field; mirrored from `displayName`.
  name          String
  image         String?

  /// Login identifier — unique, case-insensitive.
  /// IMMUTABLE after creation: it seeds the synthetic email above. To change
  /// one, deactivate the account and create a new one.
  username        String? @unique
  displayUsername String?

  /// Access control, from the admin plugin. THE single stored source of truth
  /// for whether a user may sign in — there is deliberately no `isActive`
  /// column here. DTOs expose `isActive: !banned`; UI copy says "Deactivate",
  /// never "ban", because most cases are staff leaving, not misconduct.
  /// (`isActive` on Shop, Customer, PrizeItem and ShopPrizeConfig is a
  /// different, unrelated domain flag and is untouched.)
  banned     Boolean?  @default(false)
  banReason  String?
  /// Temporary suspension, free from the plugin. No UI in v1.
  banExpires DateTime?

  /// From the admin plugin's own schema (D-123, 20 Aug 2026) — its
  /// `user.create.before` database hook unconditionally stamps
  /// `role: "user"` onto every created user through every creation path.
  /// Without this column the hook fails on every account creation. NOT our
  /// access control — nothing in this codebase reads it. `isOwner` above and
  /// `UserShop.role` below remain the only roles that matter.
  role String?

  // ── Domain fields (declared in user.additionalFields) ─────────────
  /// The mutable, human-facing name. `username` is not editable.
  displayName String
  phone       String?

  /// OWNER is the one role that stays a property of the account (D-122,
  /// 19 Aug 2026): an owner sees and acts on everything, with no shop
  /// assignment needed, and is never also assigned to an individual shop.
  /// MANAGER and STAFF are no longer columns here — see UserShop below.
  isOwner Boolean @default(false)

  mustChangePassword Boolean   @default(true)
  defaultShopId      String?
  /// Also drives the actor's businessDate — it is stable and known before the
  /// day-start shop picker is answered. See §4.7 and BUILD-LOG D-5.
  defaultShop        Shop?     @relation("DefaultShop", fields: [defaultShopId], references: [id])
  lastLoginAt        DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  // ── Auth relations ────────────────────────────────────────────────
  sessions Session[]
  accounts Account[]

  // ── Domain relations (all still point at User) ────────────────────
  userShops    UserShop[]
  workSessions WorkSession[]
  sales        Sale[]
  attendances  Attendance[]
  expenses     Expense[]
  redemptions  Redemption[]
  auditLogs    AuditLog[]
  marbleTxns   MarbleLedger[]
  ticketTxns   TicketLedger[]

  @@index([isOwner, banned])
  @@map("user")
}

/// The role lives HERE, not on User (D-122, 19 Aug 2026): a user can be
/// MANAGER at one shop and STAFF at another. OWNER never gets a row here —
/// it is a global flag on User (`isOwner`) and needs no per-shop assignment
/// (§3.1). A CHECK constraint enforces `role <> 'OWNER'` at the DB level.
model UserShop {
  id           String  @id @default(cuid())
  userId       String
  shopId       String
  /// MANAGER or STAFF only — see the CHECK constraint above.
  role         Role
  /// Purchasing permission (§7.5), meaningful only when role = MANAGER.
  /// Unlocks prize cost entry and stock valuation for THIS SHOP ONLY.
  canEnterCost Boolean @default(false)
  user         User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  shop         Shop    @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([userId, shopId])
  @@index([shopId])
  @@index([userId])
}

/// Owned by Better Auth. The hand-rolled session table was deleted in Phase 1
/// (§5.4) — the library handles token generation, rotation, timing-safe
/// comparison and cookie flags, which is exactly the category of code worth
/// not writing yourself.
model Session {
  id        String   @id @default(cuid())
  token     String   @unique
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  ipAddress String?
  userAgent String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// Set by the admin plugin's impersonation, which is NOT enabled — §5.4
  /// permits it only if audit-logged.
  impersonatedBy String?

  @@index([userId])
  @@index([expiresAt])
  @@map("session")
}

/// Owned by Better Auth. Holds the argon2id password hash in `password` for
/// the credential provider. This is why `User` has no `passwordHash`.
model Account {
  id         String @id @default(cuid())
  accountId  String
  providerId String
  userId     String
  user       User   @relation(fields: [userId], references: [id], onDelete: Cascade)

  accessToken           String?
  refreshToken          String?
  idToken               String?
  accessTokenExpiresAt  DateTime?
  refreshTokenExpiresAt DateTime?
  scope                 String?
  /// argon2id hash (§5.4). Never leaves the server.
  password              String?

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@map("account")
}

/// Owned by Better Auth. Unused — there are no email flows (§5.4) — but the
/// library expects the table to exist.
model Verification {
  id         String   @id @default(cuid())
  identifier String
  value      String
  expiresAt  DateTime
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@index([identifier])
  @@map("verification")
}

/// One row per user per business day: which shop they declared they are at.
model WorkSession {
  id            String   @id @default(cuid())
  userId        String
  shopId        String
  businessDate  DateTime @db.Date
  selectedAt    DateTime @default(now())
  changedCount  Int      @default(0)
  user          User     @relation(fields: [userId], references: [id])
  shop          Shop     @relation(fields: [shopId], references: [id])

  @@unique([userId, businessDate])
  @@index([shopId, businessDate])
}

// ─────────────────────────────── SALES ───────────────────────────────

model SalePreset {
  id          String   @id @default(cuid())
  shopId      String
  shop        Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  label       String                          // "Rp 50.000"
  amount      Decimal  @db.Decimal(14, 2)
  sortOrder   Int      @default(0)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())

  sales       Sale[]

  @@index([shopId, isActive, sortOrder])
}

model Sale {
  id             String        @id @default(cuid())
  shopId         String
  shop           Shop          @relation(fields: [shopId], references: [id])
  recordedById   String
  recordedBy     User          @relation(fields: [recordedById], references: [id])
  customerId     String?
  customer       Customer?     @relation(fields: [customerId], references: [id])
  presetId       String?
  preset         SalePreset?   @relation(fields: [presetId], references: [id])

  amount         Decimal       @db.Decimal(14, 2)
  paymentMethod  PaymentMethod
  isCustomAmount Boolean       @default(false)
  status         SaleStatus    @default(COMPLETED)

  businessDate   DateTime      @db.Date
  occurredAt     DateTime      @default(now())

  voidedAt       DateTime?
  voidedById     String?
  voidReason     String?
  note           String?

  @@index([shopId, businessDate])
  @@index([customerId, occurredAt])
  @@index([recordedById, businessDate])
  @@index([businessDate])
}

// ─────────────────────────── CUSTOMERS & BALANCES ───────────────────────────

model Customer {
  id              String   @id @default(cuid())
  name            String
  phoneRaw        String
  phoneNormalized String   @unique             // "+628123456789"
  note            String?
  isActive        Boolean  @default(true)

  /// Cached from ledgers inside the same transaction. Ledger is the source of truth.
  marbleBalance   Int      @default(0)
  ticketBalance   Int      @default(0)

  firstSeenAt     DateTime @default(now())
  lastSeenAt      DateTime @default(now())
  mergedIntoId    String?                        // set when this record was merged away
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  sales           Sale[]
  marbleTxns      MarbleLedger[]
  ticketTxns      TicketLedger[]
  redemptions     Redemption[]

  @@index([name])
  @@index([lastSeenAt])
}

model MarbleLedger {
  id           String        @id @default(cuid())
  customerId   String
  customer     Customer      @relation(fields: [customerId], references: [id])
  shopId       String
  shop         Shop          @relation(fields: [shopId], references: [id])
  userId       String
  user         User          @relation(fields: [userId], references: [id])

  type         MarbleTxnType
  delta        Int                              // signed
  balanceAfter Int                              // snapshot for audit
  reason       String?                          // required for ADJUST
  saleId       String?
  businessDate DateTime      @db.Date
  occurredAt   DateTime      @default(now())

  @@index([customerId, occurredAt])
  @@index([shopId, businessDate])
}

model TicketLedger {
  id           String        @id @default(cuid())
  customerId   String
  customer     Customer      @relation(fields: [customerId], references: [id])
  shopId       String
  shop         Shop          @relation(fields: [shopId], references: [id])
  userId       String
  user         User          @relation(fields: [userId], references: [id])

  type         TicketTxnType
  delta        Int
  balanceAfter Int
  reason       String?
  redemptionId String?
  businessDate DateTime      @db.Date
  occurredAt   DateTime      @default(now())

  @@index([customerId, occurredAt])
  @@index([shopId, businessDate])
}

// ─────────────────────────── PRIZES & INVENTORY ───────────────────────────

/// Global catalog. Stock is per shop, held in PrizeBatch.
model PrizeItem {
  id          String   @id @default(cuid())
  sku         String   @unique
  name        String
  category    String?
  imagePath   String?
  ticketCost  Int                                  // GLOBAL price — same at every branch
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  configs     ShopPrizeConfig[]
  batches     PrizeBatch[]
  lines       RedemptionLine[]
  movements   StockMovement[]
  transferLines PrizeTransferLine[]
  opnameLines OpnameLine[]

  @@index([isActive, name])
}

/// Per-shop stocking policy for a catalog item.
/// NOTE: ticketCost is NOT here — it lives on PrizeItem and is global (§4.8).
model ShopPrizeConfig {
  id                 String    @id @default(cuid())
  shopId             String
  prizeItemId        String
  shop               Shop      @relation(fields: [shopId], references: [id], onDelete: Cascade)
  prizeItem          PrizeItem @relation(fields: [prizeItemId], references: [id], onDelete: Cascade)

  lowStockThreshold  Int       @default(0)             // 0 = no alert
  isActive           Boolean   @default(true)          // does this branch carry the item
  updatedAt          DateTime  @updatedAt

  @@unique([shopId, prizeItemId])
  @@index([shopId, isActive])
}

/// One delivery of one prize into one shop at one cost. THE unit of stock.
model PrizeBatch {
  id           String    @id @default(cuid())
  shopId       String
  prizeItemId  String
  shop         Shop      @relation(fields: [shopId], references: [id])
  prizeItem    PrizeItem @relation(fields: [prizeItemId], references: [id])

  batchCode    String?
  qtyReceived  Int
  qtyRemaining Int                                   // decremented FIFO; never < 0
  unitCogs     Decimal   @db.Decimal(14, 2)          // OWNER-ONLY FIELD
  supplier     String?
  note         String?
  isAdjustment Boolean   @default(false)             // created by positive opname variance
  needsCosting Boolean   @default(false)             // manager received it; owner must set unitCogs (§7.5)
  isVoid       Boolean   @default(false)

  receivedAt   DateTime                              // FIFO sort key; preserved across transfers
  createdAt    DateTime  @default(now())
  createdById  String?
  sourceBatchId String?                              // provenance when moved between shops

  consumptions StockConsumption[]

  @@index([shopId, prizeItemId, receivedAt])
  @@index([shopId, prizeItemId, qtyRemaining])
}

/// Append-only record of every quantity change. Reporting reads this.
model StockMovement {
  id           String            @id @default(cuid())
  shopId       String
  prizeItemId  String
  shop         Shop              @relation(fields: [shopId], references: [id])
  prizeItem    PrizeItem         @relation(fields: [prizeItemId], references: [id])

  type         StockMovementType
  qtyDelta     Int                                   // signed
  refType      String?                               // "REDEMPTION" | "TRANSFER" | "OPNAME" | ...
  refId        String?
  userId       String?
  reason       String?
  businessDate DateTime          @db.Date
  occurredAt   DateTime          @default(now())

  consumptions StockConsumption[]

  @@index([shopId, prizeItemId, occurredAt])
  @@index([businessDate, type])
}

/// FIFO detail: which batch was drawn down, how much, at what cost.
/// Sum(qty * unitCogsAtConsumption) IS the prize expense. OWNER-ONLY.
model StockConsumption {
  id            String        @id @default(cuid())
  movementId    String
  movement      StockMovement @relation(fields: [movementId], references: [id])
  batchId       String
  batch         PrizeBatch    @relation(fields: [batchId], references: [id])
  qty           Int
  unitCogsAtConsumption Decimal @db.Decimal(14, 2)
  createdAt     DateTime      @default(now())

  @@index([movementId])
  @@index([batchId])
}

// ─────────────────────────── REDEMPTION ───────────────────────────

model Redemption {
  id            String   @id @default(cuid())
  shopId        String
  shop          Shop     @relation(fields: [shopId], references: [id])
  customerId    String
  customer      Customer @relation(fields: [customerId], references: [id])
  userId        String
  user          User     @relation(fields: [userId], references: [id])

  totalTickets  Int
  totalCogs     Decimal  @db.Decimal(14, 2)          // OWNER-ONLY FIELD
  isVoided      Boolean  @default(false)
  voidedAt      DateTime?
  voidedById    String?
  voidReason    String?

  businessDate  DateTime @db.Date
  occurredAt    DateTime @default(now())

  lines         RedemptionLine[]

  @@index([shopId, businessDate])
  @@index([customerId, occurredAt])
}

model RedemptionLine {
  id             String     @id @default(cuid())
  redemptionId   String
  redemption     Redemption @relation(fields: [redemptionId], references: [id], onDelete: Cascade)
  prizeItemId    String
  prizeItem      PrizeItem  @relation(fields: [prizeItemId], references: [id])

  qty            Int
  ticketCostEach Int                                  // snapshot at time of redemption
  ticketCostTotal Int
  cogsTotal      Decimal    @db.Decimal(14, 2)        // OWNER-ONLY FIELD
  movementId     String?

  @@index([redemptionId])
  @@index([prizeItemId])
}

// ─────────────────────────── TRANSFERS ───────────────────────────

model PrizeTransfer {
  id            String         @id @default(cuid())
  fromShopId    String
  toShopId      String
  fromShop      Shop           @relation("TransferFrom", fields: [fromShopId], references: [id])
  toShop        Shop           @relation("TransferTo", fields: [toShopId], references: [id])

  status        TransferStatus @default(IN_TRANSIT)
  note          String?

  dispatchedById String
  dispatchedAt   DateTime      @default(now())
  receivedById   String?
  receivedAt     DateTime?
  cancelledById  String?
  cancelledAt    DateTime?

  businessDate   DateTime      @db.Date
  lines          PrizeTransferLine[]

  @@index([fromShopId, status])
  @@index([toShopId, status])
}

model PrizeTransferLine {
  id           String        @id @default(cuid())
  transferId   String
  transfer     PrizeTransfer @relation(fields: [transferId], references: [id], onDelete: Cascade)
  prizeItemId  String
  prizeItem    PrizeItem     @relation(fields: [prizeItemId], references: [id])
  qty          Int
  /// Snapshot of the FIFO split consumed at source:
  /// [{ sourceBatchId, qty, unitCogs, receivedAt }] — used to recreate batches on receive.
  batchPlan    Json

  @@index([transferId])
}

// ─────────────────────────── OPNAME ───────────────────────────

model OpnameSession {
  id           String   @id @default(cuid())
  shopId       String
  shop         Shop     @relation(fields: [shopId], references: [id])
  userId       String
  note         String?
  isCommitted  Boolean  @default(false)
  businessDate DateTime @db.Date
  startedAt    DateTime @default(now())
  committedAt  DateTime?

  lines        OpnameLine[]

  @@index([shopId, businessDate])
}

model OpnameLine {
  id           String        @id @default(cuid())
  sessionId    String
  session      OpnameSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  prizeItemId  String
  prizeItem    PrizeItem     @relation(fields: [prizeItemId], references: [id])

  systemQty    Int
  countedQty   Int
  variance     Int
  varianceValue Decimal?     @db.Decimal(14, 2)      // OWNER-ONLY FIELD
  note         String?

  @@index([sessionId])
}

// ─────────────────────────── EXPENSES ───────────────────────────

model ExpenseCategory {
  id         String    @id @default(cuid())
  name       String    @unique
  isArchived Boolean   @default(false)
  sortOrder  Int       @default(0)
  createdAt  DateTime  @default(now())

  expenses   Expense[]
}

model Expense {
  id            String          @id @default(cuid())
  shopId        String
  shop          Shop            @relation(fields: [shopId], references: [id])
  categoryId    String
  category      ExpenseCategory @relation(fields: [categoryId], references: [id])
  userId        String
  user          User            @relation(fields: [userId], references: [id])

  amount        Decimal         @db.Decimal(14, 2)
  note          String?
  receiptPath   String?
  businessDate  DateTime        @db.Date
  createdAt     DateTime        @default(now())
  isDeleted     Boolean         @default(false)

  @@index([shopId, businessDate])
  @@index([categoryId, businessDate])
}

// ─────────────────────────── ATTENDANCE ───────────────────────────

model Shift {
  id         String   @id @default(cuid())
  shopId     String
  shop       Shop     @relation(fields: [shopId], references: [id], onDelete: Cascade)
  name       String                                    // "Morning"
  startTime  DateTime @db.Time(0)
  endTime    DateTime @db.Time(0)
  daysOfWeek Int[]    @default([0,1,2,3,4,5,6])        // 0 = Sunday
  isActive   Boolean  @default(true)

  attendances Attendance[]

  @@index([shopId, isActive])
}

/// §4.14.1 — the recurring pattern. `daysOfWeek` is intersected with the
/// shift's own days, never unioned. Closed with `effectiveTo`, not deleted.
model ScheduleAssignment {
  id            String    @id @default(cuid())
  userId        String
  shopId        String
  shiftId       String
  daysOfWeek    Int[]                       // 0 = Sunday
  /// Defaulted to today by the service; never typed by the owner.
  effectiveFrom DateTime  @db.Date
  /// SOFT DELETE. Hidden everywhere, kept as the record behind past attendance.
  removedAt     DateTime?
  removedById   String?
  note          String?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  createdById   String?

  @@index([userId, effectiveFrom])
  @@index([shopId, effectiveFrom])
  @@index([shiftId])
  @@index([shopId, removedAt])
}

/// §4.14.2 — a period of approved absence. Inclusive at both ends.
model ScheduleLeave {
  id          String   @id @default(cuid())
  userId      String
  /// Null = every branch this person works at, which is the normal case.
  shopId      String?
  startDate   DateTime @db.Date
  endDate     DateTime @db.Date
  reason      String
  createdAt   DateTime @default(now())
  createdById String?

  @@index([userId, startDate, endDate])
  @@index([shopId, startDate])
}

/// §4.14.1 — a single-date exception. Keyed on (user, shift, date), so a whole
/// day's leave is one row per shift. Always carries a reason.
model ScheduleOverride {
  id           String               @id @default(cuid())
  userId       String
  shopId       String
  shiftId      String
  businessDate DateTime             @db.Date
  kind         ScheduleOverrideKind // ADDED | REMOVED
  reason       String
  createdAt    DateTime             @default(now())
  createdById  String?

  @@unique([userId, shiftId, businessDate])
  @@index([shopId, businessDate])
  @@index([userId, businessDate])
}

model Attendance {
  id             String           @id @default(cuid())
  userId         String
  user           User             @relation(fields: [userId], references: [id])
  shopId         String
  shop           Shop             @relation(fields: [shopId], references: [id])
  shiftId        String?
  shift          Shift?           @relation(fields: [shiftId], references: [id])

  businessDate   DateTime         @db.Date
  clockInAt      DateTime
  clockOutAt     DateTime?

  /// Snapshot so later shift edits don't rewrite history.
  shiftStartAtCapture DateTime?
  graceMinAtCapture   Int?
  status         AttendanceStatus @default(PRESENT)
  isLate         Boolean          @default(false)
  lateMinutes    Int              @default(0)

  /// §4.14.1. Defaults to SCHEDULED so rows predating the timetable, and rows
  /// at branches with no roster, are not retroactively reported as cover.
  scheduleSource ScheduleSource   @default(SCHEDULED)
  /// Required by the SERVICE when scheduleSource = COVER; nullable in the
  /// database so an owner-entered MANUAL record is not forced to invent one.
  coverReason    String?

  photoPath      String?
  photoPurgedAt  DateTime?
  latitude       Decimal?         @db.Decimal(10, 7)
  longitude      Decimal?         @db.Decimal(10, 7)
  accuracyM      Int?
  locationDenied Boolean          @default(false)

  clockOutPhotoPath String?
  note           String?
  editedById     String?
  editedAt       DateTime?

  @@unique([userId, businessDate])
  @@index([shopId, businessDate])
  @@index([businessDate, isLate])
}

// ─────────────────────────── SYSTEM ───────────────────────────

model AuditLog {
  id         String   @id @default(cuid())
  userId     String?
  user       User?    @relation(fields: [userId], references: [id])
  role       Role?
  shopId     String?
  entity     String                                    // "Sale", "PrizeBatch", ...
  entityId   String?
  action     String                                    // "VOID", "ADJUST", ...
  before     Json?
  after      Json?
  reason     String?
  ipAddress  String?
  occurredAt DateTime @default(now())

  @@index([entity, entityId])
  @@index([userId, occurredAt])
  @@index([occurredAt])
}

model IdempotencyKey {
  key        String   @id
  userId     String
  endpoint   String
  responseJson Json
  createdAt  DateTime @default(now())

  @@index([createdAt])
}

model BackupRun {
  id          String   @id @default(cuid())
  startedAt   DateTime @default(now())
  finishedAt  DateTime?
  succeeded   Boolean  @default(false)
  sizeBytes   BigInt?
  filePath    String?
  checksum    String?
  errorText   String?

  @@index([startedAt])
}

/// Durable warning raised by background jobs. Phase 3 records balance-cache
/// drift here; the owner dashboard presents active alerts in Phase 8.
model SystemAlert {
  id          String    @id @default(cuid())
  key         String    @unique
  severity    String
  title       String
  message     String
  details     Json?
  isActive    Boolean   @default(true)
  firstSeenAt DateTime  @default(now())
  lastSeenAt  DateTime  @default(now())
  resolvedAt  DateTime?

  @@index([isActive, severity, lastSeenAt])
}

model AppSetting {
  key       String   @id
  value     Json
  updatedAt DateTime @updatedAt
}
```

### 6.1 Data model notes for the agent

1. **Never write a `qtyOnHand` column on `ShopPrizeConfig`.** On-hand is always `SUM(PrizeBatch.qtyRemaining)` for that shop+item where `isVoid = false`. If performance ever demands a cache, add it as a materialised view, not a mutable column.
2. `Customer.marbleBalance` / `ticketBalance` **are** caches, and that is deliberate — the lookup screen must be instant. They are only ever written inside the same transaction as the matching ledger insert. The nightly reconciliation job (§11) recomputes both from the ledgers and raises a critical alert on any mismatch.
3. Fields marked **OWNER-ONLY** (`unitCogs`, `totalCogs`, `cogsTotal`, `varianceValue`, and all of `StockConsumption`) must never leave the server in a response to a MANAGER or STAFF session. See §7.5.
4. `businessDate` is written by the server on every transactional row. The client never sends it.
5. Soft-delete (`isDeleted` / `isVoid` / `status = VOIDED`) everywhere that touches money or stock. Hard deletes are only permitted for: unused expense categories, unused sale presets, and purged attendance photo *files*.
6. Add `@@map` snake_case names if you prefer conventional Postgres naming — but do it in the very first migration, never later.

---

## 7. API specification

REST + JSON, under `/api`. All endpoints require a valid session except `POST /api/auth/login`. All mutating endpoints accept an `Idempotency-Key` header.

**Standard error shape:**

```json
{ "error": { "code": "INSUFFICIENT_TICKETS", "message": "Customer has 120 tickets, redemption needs 250.", "details": {} } }
```

Error codes to define: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `INSUFFICIENT_TICKETS`, `INSUFFICIENT_MARBLES`, `INSUFFICIENT_STOCK`, `NO_WORK_SESSION`, `ALREADY_CLOCKED_IN`, `CATEGORY_IN_USE`, `DUPLICATE_PHONE`, `SALE_NOT_VOIDABLE`, `RATE_LIMITED`.

### 7.1 Auth & session

| Method | Path | Role | Purpose |
|---|---|---|---|
| POST | `/api/auth/login` | — | Username + password → session cookie. Returns user, role, shops, whether a work session exists today, whether clocked in today. |
| POST | `/api/auth/logout` | any | Destroy session. |
| GET | `/api/auth/me` | any | Bootstrap payload for the app shell: user, role, assigned shops, current work session, clock-in state, unread alerts. |
| POST | `/api/auth/change-password` | any | Requires current password unless `mustChangePassword`. |
| POST | `/api/work-session` | any | `{ shopId }` — create today's work session. |
| PATCH | `/api/work-session` | any | `{ shopId, reason? }` — change current shop; reason required if records exist today. |

### 7.2 Sales

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/shops/:id/presets` | any | Active presets for the sale screen. |
| POST | `/api/sales` | any | `{ presetId \| amount, paymentMethod, customerId?, note? }`. Shop and user come from the work session — **the client cannot set them**. |
| GET | `/api/sales` | O/M/S | Filters: `shopId`, `from`, `to`, `userId`, `customerId`, `paymentMethod`. Scoped by role. |
| POST | `/api/sales/:id/void` | O / M(same day) | `{ reason }`. |
| GET | `/api/sales/today-summary` | any | Count, total, split by payment method, for the current work-session shop. |

### 7.3 Customers, marbles, tickets

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/customers?q=` | any | Search by phone (partial, digits-only match) or name. Returns role-shaped DTO. |
| POST | `/api/customers` | any | `{ name, phone, note? }`. |
| GET | `/api/customers/:id` | any | Full profile for OWNER; minimal profile for MANAGER/STAFF (§7.5). |
| PATCH | `/api/customers/:id` | any | Name, phone, note. |
| POST | `/api/customers/merge` | OWNER | `{ winnerId, loserId }` — moves all history in one transaction. |
| GET | `/api/customers/:id/ledger` | any | Combined marble + ticket history, paginated. |
| POST | `/api/marbles/deposit` | any | `{ customerId, qty, note? }`. |
| POST | `/api/marbles/withdraw` | any | `{ customerId, qty, note? }`. |
| POST | `/api/marbles/adjust` | O/M | `{ customerId, delta, reason }` — reason mandatory. |
| POST | `/api/tickets/award` | any | `{ customerId, qty, note? }`. |
| POST | `/api/tickets/adjust` | O/M | `{ customerId, delta, reason }`. |

### 7.4 Prizes, stock, redemption, transfers

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/prizes?shopId=` | any | Catalog + global ticket cost + on-hand qty at that shop + low-stock flag. **No cost fields unless `canSeeCost`.** |
| POST | `/api/prizes` | O/M | Create catalog item, including global `ticketCost`. |
| PATCH | `/api/prizes/:id` | O/M | Name, category, active, `ticketCost`. Changing `ticketCost` affects **all branches** — audit-logged, owner alerted (§4.8). *(The image is NOT set here — see the three image rows below. BUILD-LOG D-118.)* |
| GET | `/api/prizes/:id/image` | any | The catalog image, served only to a signed-in session — never a static path. Staff need it to redeem (§8.6). |
| POST | `/api/prizes/:id/image` | O/M | Upload or replace the image, `multipart/form-data` field `image`. The superseded file is deleted. Separate from `PATCH` so a failed upload cannot take a text edit down with it, matching the receipt route (§7.6). |
| DELETE | `/api/prizes/:id/image` | O/M | Remove the image. Idempotent — removing when there is none is a 200, not a 404. |
| PUT | `/api/shops/:shopId/prizes/:prizeId/config` | O/M | `{ lowStockThreshold, isActive }` only. Ticket cost is not settable here. |
| POST | `/api/stock/batches` | O/M | Receive stock. `{ shopId, prizeItemId, qtyReceived, supplier?, batchCode?, receivedAt, unitCogs? }`. `unitCogs` is **rejected with 403** unless `canSeeCost`; omitted means `needsCosting = true`. See §7.5. |
| GET | `/api/stock/batches?shopId=&prizeId=` | O / M+P (own shops) | Batch list with costs. |
| GET | `/api/stock/uncosted` | O / M+P (own shops) | Batches awaiting cost. |
| PATCH | `/api/stock/batches/:id/cost` | O / M+P (own shops) | Set `unitCogs`, clear the flag, trigger the consumption backfill. |
| GET | `/api/stock/on-hand?shopId=` | any | Per-item on-hand, in-transit, low-stock flag. |
| POST | `/api/stock/adjust` | O/M | `{ shopId, prizeItemId, delta, reason }`. |
| POST | `/api/redemptions` | any | `{ customerId, lines: [{ prizeItemId, qty }] }`. Shop from work session. Full transaction per §4.9. |
| GET | `/api/redemptions` | O/M | Filterable; costs owner-only. |
| POST | `/api/redemptions/:id/void` | OWNER | Within 24 h. Restores tickets + exact batches. |
| POST | `/api/transfers` | O/M | `{ fromShopId, toShopId, lines: [{ prizeItemId, qty }], note? }` → dispatch. |
| POST | `/api/transfers/:id/receive` | O/M(dest) | Confirm arrival, recreate batches. |
| POST | `/api/transfers/:id/cancel` | O/M(source) | Restore source batches. |
| GET | `/api/transfers?status=` | O/M | Inbox of pending inbound/outbound transfers. |
| POST | `/api/opname` | O/M | Start a session. |
| PUT | `/api/opname/:id/lines` | O/M | Save counted quantities. |
| POST | `/api/opname/:id/commit` | O/M | Apply variances per §4.11. |

### 7.5 Cost entry and the Purchasing permission (read this carefully)

The requirement is: *managers must never see cost.* But someone has to enter cost, or FIFO has no basis.

**Resolution (decided, 3 Aug 2026): cost is entered by the OWNER, plus optionally one trusted manager holding the Purchasing permission.**

#### The permission

- `UserShop.canEnterCost` is a boolean **per shop assignment** (D-122 — role and Purchasing both moved off `User` onto `UserShop`, since a manager's access is per-shop, not per-account), granted and revoked **only by the owner**, from Settings → Employees. Every grant and revoke is audit-logged.
- It is meaningful only for a MANAGER **at that shop**. It is ignored on a STAFF assignment, and a manager holding it at one shop has no cost rights at a different shop where they are only STAFF (or hold no Purchasing grant).
- A manager holding it at a shop may:
  - see and enter `unitCogs` when receiving a batch, **at that shop only**;
  - view the batch list with costs, at that shop only;
  - see stock valuation for that shop.
- It does **not** grant: profit or margin reports, prize-expense reports, cost visibility at shops where they are not assigned or do not hold the grant, opname variance *value*, or any all-shops view. The permission unlocks *cost entry*, not *profitability*.
- Call it **"Purchasing"** in the UI, not "can see costs" — it describes the job, and it reads better to the person who has it.

#### The uncosted-batch queue (still needed)

A manager **without** the permission can still receive stock — they just cannot price it.

- They submit `{ prizeItemId, qty, supplier?, batchCode?, receivedAt }` with **no cost field on the form at all**.
- The batch is created with `unitCogs = 0` and `needsCosting = true`.
- The owner dashboard shows a **"Batches awaiting cost"** queue. Filling in the unit cost clears the flag. Purchasing managers see the queue for their own shops.
- FIFO consumes the batch normally in the meantime, recording `unitCogsAtConsumption = 0`. When the cost is later set, a **backfill routine** updates every `StockConsumption` row for that batch recorded at 0, and recalculates the affected `Redemption.totalCogs` and `RedemptionLine.cogsTotal`. Every backfill is audit-logged.
- While any batch is uncosted, the owner dashboard shows a warning — prize expense is understated until the queue is cleared.

#### Response DTO rule

The gate is a single derived value, computed server-side per request:

```ts
// D-122: role and canEnterCost are per-shop — canSeeCostForShop(actor, shopId)
// is the only version of this gate that may ever answer for a specific shop.
function canSeeCostForShop(actor: Actor, shopId: string): boolean {
  if (actor.isOwner) return true;
  const sr = actor.shopRoles.get(shopId);
  return sr?.role === 'MANAGER' && sr.canEnterCost === true;
}
```

Build two explicit response shapes per resource — `toCostDTO()` and `toRestrictedDTO()` — in `src/server/dto/`. The restricted builder **physically does not read the cost columns**. Do not implement this by deleting keys from a full object; a future refactor will silently reintroduce the leak. Add a test asserting that a plain MANAGER's serialized response for every prize, stock, redemption, report and CSV export endpoint contains none of the strings `cogs`, `unitCost`, `varianceValue`, `margin`, `profit`, `valuation`. Add a second test asserting a Purchasing manager sees cost for an assigned shop and gets a `403` for an unassigned one.

**Response DTO rule:** build two explicit response shapes per resource — `toOwnerDTO()` and `toRestrictedDTO()` — in `src/server/dto/`. The restricted builder physically does not read the cost columns. Do not implement this by deleting keys from an owner object; a future refactor will silently reintroduce the leak. Add a test that asserts a MANAGER token's serialized response for every prize/stock/redemption/report endpoint contains none of the strings `cogs`, `unitCost`, `varianceValue`, `expense` (cost sense), `margin`, `profit`.

### 7.6 Expenses

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/expense-categories` | O/M | Non-archived list. |
| POST | `/api/expense-categories` | OWNER | Create. |
| PATCH | `/api/expense-categories/:id` | OWNER | Rename / archive. |
| DELETE | `/api/expense-categories/:id` | OWNER | 409 `CATEGORY_IN_USE` with count if any expense references it. |
| POST | `/api/expenses` | O/M | `{ shopId, categoryId, amount, businessDate, note?, receipt? }`. |
| GET | `/api/expenses` | O/M | Filter by shop, category, date range. |
| PATCH / DELETE | `/api/expenses/:id` | OWNER | Soft delete, audit-logged. |

### 7.7 Attendance

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/attendance/status` | any | Has the current user clocked in for today's business date? Drives the red banner. |
| GET | `/api/shops/:id/shifts` | any | Shifts available today at this shop. |
| POST | `/api/attendance/clock-in` | any | `multipart/form-data`: `photo` (blob), `shiftId`, `latitude?`, `longitude?`, `accuracyM?`, `locationDenied`. Server watermarks, stores, computes lateness. |
| POST | `/api/attendance/clock-out` | any | Optional photo per shop setting. |
| GET | `/api/attendance` | O/M | Filter by shop, user, date range, late-only. |
| GET | `/api/attendance/:id/photo` | O/M(own shop)/self | Authenticated image stream. Never a static path. |
| PATCH | `/api/attendance/:id` | OWNER | Excuse, correct, annotate. Audit-logged. |
| POST/PATCH/DELETE | `/api/shops/:id/shifts` | O/M | Manage shifts. |
| GET | `/api/shops/:id/schedule` | any | The timetable (§4.14.1). `?week=YYYY-MM-DD` → seven resolved days; `?date=` → one resolved day; `?leave=true` → leave records; neither → the raw recurring assignments (`?includeRemoved=true` to include removed ones). |
| POST | `/api/shops/:id/schedule` | O/M | Roster someone onto a recurring shift. |
| PATCH/DELETE | `/api/schedule/assignments/:id` | O/M | Change a recurring assignment's days, or remove it. DELETE is a **soft delete** (`removedAt`) — hidden from the roster, kept as the record behind past attendance. |
| POST | `/api/schedule/assignments/:id/restore` | O/M | Undo a removal. Re-checks the shift is active and the person still works here. |
| POST | `/api/schedule/leave` | O/M | Record approved leave over a date range (§4.14.2). |
| DELETE | `/api/schedule/leave/:id` | O/M | Cancel leave. The schedule resumes for those dates. |
| POST | `/api/shops/:id/schedule/overrides` | O/M | Add a single-date exception (`ADDED`/`REMOVED`), reason required. Upserts on (user, shift, date). |
| DELETE | `/api/schedule/overrides/:id` | O/M | Undo an exception, restoring whatever the pattern said. |
| GET | `/api/schedule/me` | any | What the caller is rostered for today at their work-session shop. Drives the clock-in screen. |

### 7.8 Reports & dashboard

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/dashboard` | any | Role-shaped dashboard payload (§8.2 / §8.3). |
| GET | `/api/reports/sales` | O/M | Group by day / shop / staff / payment method. |
| GET | `/api/reports/customers` | OWNER | Spend, frequency, recency, preferred shop. |
| GET | `/api/reports/prize-expense` | OWNER | FIFO COGS by period, shop, item. |
| GET | `/api/reports/liability` | OWNER | Outstanding marbles + tickets, with estimated ticket liability value. |
| GET | `/api/reports/profit` | OWNER | Revenue − prize COGS − expenses, per shop and combined. |
| GET | `/api/reports/attendance` | O/M | Late counts, late rate, per-staff trend series. |
| GET | `/api/reports/low-stock` | O/M | Items at or below threshold. |
| GET | `/api/reports/:name/export` | O/M | CSV. Manager exports have cost columns removed at the query level. |

### 7.9 Admin

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET/POST | `/api/employees` | OWNER | List / create. Create sets a per-shop `shopRoles` array (D-122), active flag, default shop. Never `isOwner` — there is exactly one owner, fixed at bootstrap (D-123, 20 Aug 2026); this endpoint can only create MANAGER/STAFF. |
| PATCH | `/api/employees/:id` | OWNER | Edit `shopRoles` (whole-array replace, D-109/D-122), active flag, default shop. Never `isOwner` (D-123) — the owner account can be deactivated (subject to the last-active-owner guard) but never demoted, and nobody can be promoted to it, from this endpoint. |
| POST | `/api/employees/:id/reset-password` | OWNER | Sets temp password + `mustChangePassword`. |
| PATCH | `/api/shops/:id/staff` | OWNER | Assign/unassign/change-role for ONE (user, shop) pair (D-107, extended by D-122). |
| GET/POST/PATCH | `/api/shops` | OWNER | |
| GET/POST/PATCH/DELETE | `/api/shops/:id/presets` | OWNER | |
| GET | `/api/audit` | OWNER | Filterable audit log. |
| GET | `/api/backups` | OWNER | List backup runs with status, size, checksum. |
| POST | `/api/backups/run` | OWNER | Trigger a backup now. |
| GET | `/api/backups/:id/download` | OWNER | Stream the archive. |
| GET | `/api/health` | — | Liveness: DB reachable, disk free, last backup age, uncosted batch count. |

---

## 8. Screens

### 8.0 Global shell

Present on every authenticated screen:

- **Top bar:** shop name (tap to switch, per §4.7), user name, role chip, logout.
- **Red attendance banner** (§4.13) — fixed below the top bar, full width, only for users who have not clocked in today.
- **Bottom tab bar on tablet/phone**, role-dependent:
  - STAFF: `Sale` · `Customers` · `Prizes` · `Me`
  - MANAGER: `Dashboard` · `Sale` · `Customers` · `Stock` · `More`
  - OWNER: `Dashboard` · `Sales` · `Customers` · `Stock` · `Reports` · `Admin`
- **Landing route after login:** OWNER → `/dashboard`. MANAGER and STAFF → `/sale`.

### 8.1 Login and day-start

1. `/login` — username, password, big touch targets, show/hide password.
2. If `mustChangePassword` → forced change screen.
3. If no work session for today → **full-screen shop picker**. Default shop first and pre-highlighted, then other assigned shops. One tap, one confirm. Skipped automatically if the user has exactly one shop.
4. Land on the role's home screen, with the red banner if not yet clocked in.

### 8.2 `/sale` — Record a sale (the most-used screen in the product)

Design target: **a sale takes three taps.**

```
┌──────────────────────────────────────────────┐
│  Branch A  ·  Andi  ·  Staff        [logout] │
├──────────────────────────────────────────────┤
│ ⚠ YOU HAVE NOT CLOCKED IN — TAP TO CLOCK IN  │  ← red, if applicable
├──────────────────────────────────────────────┤
│                                              │
│   ┌────────┐ ┌────────┐ ┌────────┐          │
│   │ 20.000 │ │ 50.000 │ │100.000 │          │   large preset tiles
│   │        │ │        │ │        │          │   2 cols phone / 3 cols tablet
│   └────────┘ └────────┘ └────────┘          │
│   ┌────────┐ ┌────────┐ ┌────────┐          │
│   │200.000 │ │500.000 │ │ Custom │          │   Custom only if enabled
│   └────────┘ └────────┘ └────────┘          │
│                                              │
│   Payment:   [ CASH ]  [ EDC ]               │   segmented, CASH default
│                                              │
│   Customer:  [ Walk-in ▾ ]  [ 🔍 Find ]      │
│                                              │
│            [    RECORD SALE    ]             │   full-width, 64px tall
├──────────────────────────────────────────────┤
│  Today at Branch A: 34 sales · Rp 3.450.000  │
│  Recent: 50.000 CASH Budi 14:32  [void]      │
└──────────────────────────────────────────────┘
```

- Tapping a preset selects it (does not submit). Payment method defaults to CASH.
- **Customer picker sheet:** search field that matches on partial phone digits or name, a "recent customers at this shop" list, and a "+ New customer" form (name + phone). "Skip — walk-in" is always the easy option.
- On success: a large green toast with the amount, then the form resets to a clean state within 300 ms. No modal to dismiss.
- The recent-sales strip shows the last 5 sales with a `void` affordance where permitted.
- The submit button disables during flight and sends an `Idempotency-Key`.

### 8.3 `/dashboard` — Owner

- **Row 1 (today):** today's revenue · today's sale count · today's unique customers · today's tickets awarded · today's prizes redeemed.
- **Row 2 (period):** this month revenue vs last month (with % delta) · last 30 days revenue sparkline · month-to-date gross profit.
- **Row 3 (breakdown):** revenue by shop (bar) · cash vs EDC split (donut) · hourly sales heatmap for today.
- **Row 4 (alerts) — the most valuable panel:**
  - Low stock items across all shops.
  - Batches awaiting cost (§7.5).
  - Staff not yet clocked in today, per shop.
  - Staff late today.
  - Transfers in transit older than 3 days.
  - Last backup age — **red if older than 36 hours**.
  - Ledger-vs-cache drift detected by the nightly job.
- **Row 5 (liability):** outstanding marbles · outstanding tickets · estimated ticket liability value.
- **Shop filter:** `All shops` (default) or a single shop. This is the "all shop view" — it is the owner's default.

### 8.4 `/dashboard` — Manager

Same layout, minus every cost, profit and liability-value figure, and **locked to one shop at a time** via a shop selector limited to their assignments. Shows: today's revenue, sale count, customers, prizes redeemed (quantity), low stock (quantity only), team clock-in status, and their shop's 30-day revenue trend.

### 8.5 `/customers`

- Search-first screen: a single large input, keyboard defaults to numeric, matches partial phone or name.
- Result rows show **name · phone · 🔵 marbles · 🎟 tickets** — the four things staff need most.
- **Customer detail:**
  - *All roles:* name, phone, marble balance, ticket balance, and four big action buttons — `Deposit marbles`, `Withdraw marbles`, `Award tickets`, `Redeem prize`.
  - *Owner only, in a separate tab:* total spend, sale count, average spend, first/last seen, active days, visit count per shop, preferred shop, full transaction history, redemption history.
- Deposit/withdraw/award sheets are numeric keypads with quick-add chips (+10, +25, +50, +100) — staff should never use a tiny system keyboard for this.

### 8.6 `/prizes` — Redeem (staff view)

- Entered from a customer, or standalone then pick a customer.
- Header pinned: customer name + **ticket balance**, which decrements live as the cart fills.
- Grid of prize cards: image, name, **ticket cost**, `In stock: N`.
  - Affordable and in stock → tappable.
  - Not affordable → greyed, badge "needs 80 more".
  - Out of stock → greyed, badge "out of stock".
- Cart drawer: lines, quantities, total tickets, remaining balance after redemption.
- `Confirm redemption` → server transaction → success screen showing what to hand over and the new balance. Print-friendly.

### 8.7 `/stock` — Manager & owner

Tabs: **On hand · Receive · Transfers · Opname · Low stock**

- **On hand:** table of item, ticket cost, on-hand, in-transit, low-stock badge. Stock value and average cost columns appear only for the owner, or a Purchasing manager viewing one of their own shops.
- **Receive:** pick item → qty → supplier/batch code/date → save. **The cost field renders only for the owner and for a manager holding the Purchasing permission**; everyone else sees a note: *"Cost will be added by the owner."*
- **Transfers:** two lists (Outbound, Inbound). Dispatch wizard: destination shop → items + quantities → confirm. Inbound rows have a `Receive` button showing what is expected.
- **Opname:** select items or all, enter counted quantities **before** the system count is revealed, then a variance review screen, then commit. Owner sees variance value in rupiah; manager sees variance quantity only.
- **Low stock:** filtered view with a `Transfer from another branch` shortcut on each row that shows which branches have surplus.

### 8.8 `/expenses`

- List with date range and category filters, plus a running total.
- Add form: shop (pre-filled from work session, changeable by owner), category (chips), amount (numeric keypad), date (defaults today), note, optional receipt photo.
- Owner-only category manager, with the delete-if-unused rule and a clear message when refused.

### 8.9 `/attendance`

- **Clock-in flow** (from the red banner):
  1. Shift chooser — cards showing shift name, time window, and "you are X minutes late" in red if already past grace.
  2. Camera view with a live preview and a large shutter button. Copy explains that the photo is stamped with time and location.
  3. Location permission prompt fires here. If denied, an amber warning explains that the record will be flagged, with a `Continue anyway` button.
  4. Uploading → success → banner disappears, and a confirmation shows the watermarked photo.
- **My attendance:** the user's own history, with late days highlighted.
- **Team attendance** (manager, one shop / owner, all shops):
  - Calendar heatmap per staff member: green on time, amber late, red absent.
  - Ranked lateness table: staff, days worked, late days, late rate %, average minutes late.
  - Trend chart of late incidents per week.
  - Row click → detail with the watermarked photo and a map pin.
  - Owner-only `Excuse` action.

### 8.10 `/settings`

- **Current shop** — change today's shop (§4.7).
- **Change password.**
- **Owner: Shops** — create/edit shop, presets, late-grace minutes, feature toggles.
- **Owner: System** — global business-day start hour (§4.2), ticket-award reason threshold (§4.6).
- **Owner: Employees** (renamed from Users, D-122) — create an employee, set OWNER or a **per-shop role** (a checklist of shops with a role picker per shop, and a per-shop **Purchasing permission toggle**), default shop, deactivate, reset password.
- **Owner: Shops → New shop** — creates a branch and offers to clone presets and shifts from an existing shop (§5.6).
- **Owner/Manager: Shifts.**
- **Owner: Expense categories.**
- **Owner: Backups** — list, download, run now, restore instructions, off-machine copy status.
- **Owner: Audit log.**

### 8.11 Responsive rules

- Breakpoints: phone `< 640px` (1 column, bottom tabs), tablet `640–1279px` (**primary target**, 2–3 columns, bottom tabs), desktop `≥ 1280px` (left sidebar, wider tables).
- Minimum touch target 44 × 44 px; primary action buttons 56–64 px tall.

**Component size scale (normative).** shadcn's stock scale starts at `h-8`
(32 px), which is below the floor. Retune it once in
`src/components/ui/button.tsx` and the matching input/select components —
do **not** enforce it with a global CSS override, which fights the component's
own classes and breaks icon buttons:

| Size | Height | Use |
|---|---|---|
| `sm` | `h-11` — 44 px | The floor. Dense contexts only: table row actions, filter chips. |
| `default` | `h-12` — 48 px | Ordinary form and dialog buttons. |
| `lg` | `h-14` — 56 px | Primary action on a screen. |
| `xl` | `h-16` — 64 px | The one dominant action: **Record sale**, **Confirm redemption**, **Clock in**. |
| `icon` | `size-11` — 44 × 44 px | Square. Height alone is not enough for an icon button. |

Text inputs, selects and dialog close buttons need the same floor — staff
tapping a 32 px input on a tablet with wet or cold hands is the failure this
rule exists to prevent. Nothing below 44 px may be the only way to perform an
action; a 32 px control is acceptable only when a larger equivalent exists
elsewhere on the screen.
- Numeric inputs use `inputMode="numeric"` and custom on-screen keypads for money, marbles and tickets.
- Never rely on hover for anything actionable.
- Support portrait and landscape; the sale screen must be fully usable in both without scrolling on a 10" tablet.
- Optional: ship a web app manifest so tablets can "Add to home screen" and run full-screen. This costs almost nothing and makes the app feel native. **It does not add offline support** — do not imply that it does.

---

## 9. Reports — definitions

Precise definitions so numbers are never ambiguous.

| Metric | Definition |
|---|---|
| **Revenue** | `SUM(Sale.amount)` where `status = COMPLETED`, grouped by `businessDate`. Cash-in at the moment of sale. |
| **Net revenue** | Revenue minus voided sales (voids are already excluded by status; this is a display distinction only). |
| **Transactions** | Count of completed sales. |
| **Unique customers** | Distinct non-null `customerId` in completed sales for the period. Walk-ins are counted separately as "walk-in transactions". |
| **Average transaction value** | Revenue ÷ transactions. |
| **Outstanding marbles** | `SUM(Customer.marbleBalance)` — marbles physically held for customers. |
| **Tickets awarded** | `SUM(TicketLedger.delta)` where `type = AWARD`. |
| **Tickets redeemed** | `ABS(SUM(delta))` where `type = REDEEM`. |
| **Outstanding tickets** | `SUM(Customer.ticketBalance)` — the ticket liability. |
| **Prize expense (COGS)** | `SUM(StockConsumption.qty × unitCogsAtConsumption)` for movements of type `REDEEM`, by period and shop. **This is the true "value of prizes spent".** |
| **Shrinkage expense** | Same sum, for movements of type `OPNAME_LOSS` and `DAMAGE`. Reported separately — mixing it into prize expense hides theft. |
| **Operating expenses** | `SUM(Expense.amount)` where not deleted. |
| **Gross profit** | Revenue − prize expense − shrinkage expense. |
| **Net profit** | Gross profit − operating expenses. |
| **Blended COGS per ticket** | Prize expense ÷ tickets redeemed, over the trailing 90 days. |
| **Estimated ticket liability** | Outstanding tickets × blended COGS per ticket. Memo line, not booked. |
| **Stock value on hand** | `SUM(PrizeBatch.qtyRemaining × unitCogs)` per shop. Owner only. |
| **Customer lifetime value** | `SUM(Sale.amount)` per customer, all time. |
| **Active days (customer)** | Count of distinct `businessDate` with at least one completed sale. |
| **Preferred shop** | Shop with the highest completed-sale count for that customer; ties broken by most recent. |
| **Tickets awarded per staff** | `SUM(TicketLedger.delta)` where `type = AWARD`, grouped by user and business date. Fraud control — see §4.6. |
| **Tickets awarded per Rp 1.000 of sales** | Tickets awarded ÷ (revenue ÷ 1000), per shop per day. Outliers by staff member are the signal worth watching. |
| **Late rate (staff)** | Late attendance records ÷ total attendance records, per period. |
| **Attendance rate** | Days with an attendance record ÷ days scheduled (v1: days with a work session). |

**Report screens to build:** Daily Sales Summary · Sales by Staff · Sales by Shop · Payment Method Breakdown · Customer Spend Leaderboard · Prize Redemption Report · Prize Expense (FIFO) · Stock Valuation · Low Stock · Shrinkage · **Tickets Awarded by Staff** · Expense Report · Profit & Loss per Shop · Liability Report · Attendance & Lateness. All exportable to CSV, all respecting role scope.

---

## 10. Seed data

`prisma/seed.ts` creates a working system on first boot:

- One OWNER: username from `SEED_OWNER_USERNAME`, password from `SEED_OWNER_PASSWORD`, `mustChangePassword = true`. **Fail loudly at startup if these env vars are unset — never ship a hardcoded default password.**
- **One shop only**, named from `SEED_SHOP_NAME` (default `Branch 1`), plus the `HQ` pseudo-shop for non-branch expenses. Further branches are created through the UI (§5.6) — the seed must not assume a branch count.
- Default presets for that shop: `20.000`, `50.000`, `100.000`, `200.000`, `500.000`. Amounts only, no marble counts.
- Default shifts: `Morning 10:00–18:00`, `Evening 18:00–23:00`.
- The ten seed expense categories from §4.12.
- A `--demo` flag that additionally generates 3 extra shops, ~200 customers, ~2000 sales, prize items with batches, redemptions, and 60 days of attendance, so reports can be tested with realistic data. **Demo data must be clearly labelled and removable with `--reset-demo`** — you do not want it drifting into production.

---

## 11. Background jobs

All run inside the app container via node-cron, each guarded by a Postgres advisory lock, each writing a run record and logging failures.

| Job | Schedule | Action |
|---|---|---|
| **Backup** | `0 2 * * *` (02:00 shop time) | §13. |
| **Photo purge** | `0 3 * * *` | Delete attendance photo files older than 61 business days; null `photoPath`, set `photoPurgedAt`. Keep the records. |
| **Balance reconciliation** | `0 4 * * *` | Recompute `marbleBalance` and `ticketBalance` from the ledgers for every customer. On mismatch: correct the cache, write an audit row, raise a critical dashboard alert. |
| **Session cleanup** | `0 4 * * *` | Delete expired sessions and idempotency keys older than 24 h. |
| **Low stock scan** | `0 8 * * *` | Compute low-stock flags, write the dashboard alert payload. Optional email/Telegram notification. |
| **Uncosted batch nag** | `0 9 * * 1` | Weekly reminder to the owner if any batch has `needsCosting = true`. |

Timezone for all cron expressions is the server `TZ`. If you later add branches in other timezones, re-evaluate — v1 assumes one timezone.

---

## 12. Deployment

### 12.1 `docker-compose.yml` (Windows host, Docker Desktop with WSL2)

Three services: `postgres:16-alpine`, `app` (the Next.js standalone build), `cloudflared`. Key points for the agent:

- Postgres data on a **named Docker volume**, not a Windows bind mount — bind-mounting Postgres data into NTFS through WSL2 causes permission and performance problems. Backups leave the volume via `pg_dump`, so this does not hurt recoverability.
- `./data` (attendance photos, receipts) and `./backups` **are** bind mounts, so you can see and copy them from Windows Explorer.
- `restart: unless-stopped` on all three services so the stack survives a reboot. Enable "Start Docker Desktop when you log in", and set the Windows machine to auto-login after a power cut, or the shops go down until you get home.
- `app` depends on `postgres` with a healthcheck, and runs `prisma migrate deploy` on start before serving.
- Only `app` and `postgres` are on the internal network; **no host port is published for Postgres** in production.
- Pin image digests, not floating tags.

### 12.2 Cloudflare Tunnel

1. Own a domain on Cloudflare (any cheap TLD is fine).
2. Zero Trust dashboard → Networks → Tunnels → create a **named tunnel** → copy the token into `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. Add a public hostname: `arcade.yourdomain.com` → service `http://app:3000`.
4. The `cloudflared` container connects outbound. No ports opened, no static IP, no port forwarding.
5. **Recommended:** enable Cloudflare Access on that hostname with an email-OTP policy or an IP allowlist for your branches, so the login page is not exposed to the open internet.
6. Set `TRUST_PROXY=true` and read the client IP from `CF-Connecting-IP` for audit logging.

### 12.3 Migrating to Linux or Raspberry Pi

The design is already portable. To move:

1. Run a backup on the old machine and copy `backups/` and `data/` to the new one.
2. Install Docker + Docker Compose on the target.
3. Copy the repo and `.env`, adjusting `TZ` and paths.
4. `docker compose up -d` then run `scripts/restore.sh <backup-file>`.
5. Move the tunnel: install `cloudflared` with the same token, or issue a new token and update the hostname. No DNS change needed if you reuse the tunnel name.

**Raspberry Pi specifics:**

- Pi 5 with **8 GB RAM** is the sensible target; 4 GB works for three branches but leaves little headroom.
- **Boot from an SSD over USB 3, not an SD card.** Postgres write patterns destroy SD cards, usually a few months in, usually at the worst moment.
- Every image must have an `arm64` variant: `postgres:16-alpine` ✅, `node:22-alpine` ✅, `cloudflare/cloudflared` ✅.
- `sharp` and `@node-rs/argon2` both ship prebuilt arm64 binaries — verify at build time; if a prebuild is missing, the Docker build must compile it rather than silently falling back.
- Build the image on a real machine and push it to a registry, or use `docker buildx --platform linux/arm64`. Building Next.js on the Pi itself is slow and may run out of memory.
- Add `docker-compose.pi.yml` with memory limits and a lower Postgres `shared_buffers`.

### 12.4 Environment variables (`.env.example`)

```
# Database
POSTGRES_USER=marblehouse
POSTGRES_PASSWORD=            # generate, 32+ chars
POSTGRES_DB=marblehouse
DATABASE_URL=postgresql://marblehouse:${POSTGRES_PASSWORD}@postgres:5432/marblehouse

# App
NODE_ENV=production
TZ=Asia/Jakarta
APP_URL=https://arcade.yourdomain.com
SESSION_SECRET=               # generate, 64 hex chars
SESSION_TTL_HOURS=12
TRUST_PROXY=true

# Seed (required on first boot)
SEED_OWNER_USERNAME=
SEED_OWNER_PASSWORD=
SEED_SHOP_NAME=Branch 1

# Ticket award control (§4.6)
TICKET_AWARD_REASON_THRESHOLD=500

# Storage & retention
DATA_DIR=/data
BACKUP_DIR=/backups
ATTENDANCE_PHOTO_RETENTION_DAYS=61
BACKUP_RETENTION_DAYS=7
BACKUP_CRON=0 2 * * *

# Tunnel
CLOUDFLARE_TUNNEL_TOKEN=

# Optional off-machine backup copy
RCLONE_REMOTE=                # e.g. gdrive:marblehouse-backups
```

---

## 13. Backup and restore

### 13.1 What a backup contains

1. `pg_dump -Fc` custom-format dump of the entire database — this includes users, password hashes, sales, ledgers, stock, everything.
2. A tar of `/data` (attendance photos, receipt images).
3. A `manifest.json`: app version, schema migration name, timestamp, row counts per table, SHA-256 of each file.

All three are packed into `backups/marblehouse-YYYY-MM-DD-HHmm.tar.gz` with a `.sha256` sidecar.

### 13.2 Schedule and retention

- Runs at **02:00 daily**, plus on demand from the owner's Backup screen.
- Keeps the **last 7 daily backups**; deletes older ones after verifying that at least 3 valid backups remain (never delete your way to zero).
- Every run writes a `BackupRun` row. The owner dashboard shows a **red alert if the last successful backup is older than 36 hours**.

### 13.3 Restore procedure (must be rehearsed before go-live)

```bash
# 1. Fresh machine: install Docker, clone repo, restore .env
# 2. Bring up Postgres only
docker compose up -d postgres

# 3. Verify the archive
sha256sum -c marblehouse-2026-08-03-0200.tar.gz.sha256

# 4. Restore
./scripts/restore.sh backups/marblehouse-2026-08-03-0200.tar.gz
#    - unpacks
#    - drops and recreates the database
#    - pg_restore --clean --if-exists
#    - untars /data
#    - prints row counts and compares them against manifest.json

# 5. Start everything
docker compose up -d

# 6. Verify: log in as owner, check yesterday's sales total,
#    open a customer with a known balance, view an attendance photo.
```

`scripts/restore.sh` must refuse to run against a non-empty database unless `--force` is passed, and must always print a diff of manifest row counts versus restored row counts. A restore that silently loses 5% of rows is worse than a restore that fails.

### 13.4 Off-machine copy — manual, with enforcement

*(Decision, 3 Aug 2026: backups are written locally; the owner copies them to the cloud by hand.)*

That is a workable choice, but it only works if the copying actually happens, and the failure mode is silent — you find out the discipline slipped on the day the machine dies. So the app must make the manual step visible and slightly annoying to skip. Build all four:

1. **One-tap export.** Settings → Backups has a **Download latest backup** button that streams a single verified `.tar.gz`. No file browsing, no shell, no digging through folders. If it takes more than one tap, it will not happen weekly.
2. **A copy log.** Next to it, a button: **"I copied this off-machine"**. Tapping it records `lastOffsiteCopyAt` and which archive was copied. It is an honour-system checkbox — that is fine, its job is to drive the reminder below.
3. **Escalating dashboard alert.** The owner dashboard shows backup status at all times: green under 7 days since the last off-machine copy, **amber at 7 days**, **red and undismissable at 14 days**. The red state names the risk in plain language: *"Your last off-machine backup was 16 days ago. If this computer fails today you lose 16 days of sales, customer balances and attendance records."*
4. **Weekly reminder job** (`0 9 * * 1`) that raises the alert and, if you later configure email or Telegram, sends it.

`/api/health` reports both `lastLocalBackupAt` and `lastOffsiteCopyAt`. The `RCLONE_REMOTE` env var stays in the template but unset — **if you ever change your mind, automating this is a ten-line addition to `scripts/backup.sh` and nothing else in the system needs to change.** I would revisit it once you have more than two branches, because the amount you would lose grows with the business.

**One thing worth doing regardless of the cloud question:** plug a cheap USB drive into the machine permanently and let `backup.sh` copy the newest archive to it automatically. It costs nothing, needs no discipline, and covers the most likely failure by far — the internal disk dying. It does not cover fire or theft, which is what the cloud copy is for.

### 13.5 Encryption

Backups contain customer names, phone numbers and password hashes. If they leave the building, encrypt them: `gpg --symmetric --cipher-algo AES256` with a passphrase stored in a password manager, **not** in `.env`. If you skip this, do it knowingly.

---

## 14. Risks and mitigations

| # | Risk | Impact | Mitigation |
|---|---|---|---|
| R-1 | **Home internet or power goes down** → every branch stops selling. | Severe | Put the machine on a UPS. Configure BIOS to power on after AC loss and Windows to auto-login. Give staff a printed paper fallback form and a "catch-up entry" screen with a back-dated timestamp field (owner-only, audit-logged). Consider a 4G failover router. If downtime happens more than twice, revisit the offline-queue architecture. |
| R-2 | **Backups only on the broken machine.** Off-machine copying is manual by decision, so it depends on the owner's discipline — and the failure is silent until the day it matters. | Severe | §13.4 — one-tap export, copy log, escalating dashboard alert (amber 7 days, red 14), weekly reminder, plus an automatic copy to a permanently attached USB drive. Revisit automation at 3+ branches. |
| R-2b | **Ticket award inflation** — staff key in more tickets than they collected, for friends or themselves. The count is human-entered with no machine cross-check, so this is the single easiest way to steal from the business. | High | §4.6 — per-staff award attribution, the tickets-awarded-per-rupiah outlier report, a reason note above the award threshold, and physical ticket destruction at entry. Review the outlier report monthly; the deterrent is knowing you look. |
| R-3 | **Staff double-tap the sale button** on a slow connection. | High | Idempotency keys (NF-5) plus a disabled-during-flight button. Test this deliberately. |
| R-4 | **Manager sees COGS through an unfiltered endpoint or a CSV export.** Now two-sided: a plain manager must see nothing, and a Purchasing manager must see cost only for their own shops. | High | Separate DTO builders (§7.5), the `canSeeCost` gate always intersected with shop assignment, plus automated tests for both cases including exports and error payloads. |
| R-5 | **Attendance photo fraud** — staff photograph a photo, or upload an old file. | Medium | Live camera capture only, gallery upload blocked, EXIF age check, server-side watermark, geolocation, and the owner's map + photo review. This raises the effort but does not make fraud impossible; the deterrent is the review, not the tech. |
| R-6 | **Ledger cache drift** between `Customer.marbleBalance` and the ledger. | High | Same-transaction writes, nightly reconciliation with a critical alert, and `balanceAfter` snapshots on every ledger row for forensic replay. |
| R-7 | **FIFO bugs silently corrupt cost accounting.** | High | The FIFO engine is one file with a comprehensive unit test suite (§15). Never let the agent inline FIFO logic into a route handler. |
| R-8 | **Uncosted batches understate prize expense** (§7.5). | Medium | Owner queue, dashboard warning, weekly nag job, retroactive backfill with audit trail. |
| R-9 | **Tablets left logged in at shops overnight.** | Medium | 12-hour rolling session, auto-logout, forced shop re-selection each business day, optional Cloudflare Access IP allowlist. |
| R-10 | **Raspberry Pi SD card death.** | High | SSD only. See §12.3. |
| R-11 | **Customers dispute a marble or ticket balance.** | Medium | Full append-only ledger with staff attribution, plus a printable balance receipt after every deposit/award. Print or show a QR the customer can screenshot. |
| R-12 | **Scope creep during vibe coding** — the agent builds phase 6 while phase 2 is untested. | High | Follow §16 strictly. Do not start a phase until the previous phase's acceptance checks pass. |
| R-13 | **Migration edited by hand or `db push` used in production**, causing schema drift. | High | `prisma migrate deploy` only, in the container start command. Add a CI check that `prisma migrate diff` against the committed schema is empty. |
| R-14 | **Personal data (names, phones, photos) held without protection.** | Medium | Encrypt backups, HTTPS only via the tunnel, no public static file serving, role-scoped access, and a documented data retention position (photos 61 days; customer data kept while active). |

---

## 15. Testing requirements

Minimum bar before go-live. The agent should write these as it builds each phase, not at the end.

**Unit tests — the FIFO engine (`src/server/services/inventory.ts`) is the priority.**

1. Consume within a single batch.
2. Consume spanning exactly two batches.
3. Consume spanning three batches with a remainder.
4. Consume exactly the last unit of the last batch.
5. Consume more than on-hand → rejected, no partial writes.
6. Consumption honours `receivedAt` order, including a transferred batch with a preserved older `receivedAt` that must be consumed before a locally-newer batch.
7. Zero-cost (uncosted) batch consumption, then owner backfills cost → `StockConsumption`, `RedemptionLine.cogsTotal` and `Redemption.totalCogs` all update correctly.
8. Positive opname variance creates an adjustment batch at weighted-average cost.
9. Negative opname variance consumes FIFO and is categorised as `OPNAME_LOSS`, not `REDEEM`.
10. Redemption void restores the exact batches, in the exact quantities, that were consumed.

**Unit tests — other**

- Business-date computation across the global `businessDayStartHour` boundary, including 03:59, 04:00, 23:59 and 00:01.
- A work session created at 02:00 gets the *previous* calendar date, and a sale recorded ten minutes later gets the same `businessDate`. These two must never disagree.
- Lateness calculation, including a shift that crosses midnight and a grace-period boundary at exactly 5 minutes (5:00 late is not late; 5:01 is).
- Phone normalisation: `0812...`, `+62812...`, `62812...`, and formats with spaces and dashes all collapse to one key.
- Money arithmetic never produces a floating-point artefact.

**Integration tests**

- Full redemption transaction: insufficient tickets → nothing written. Insufficient stock → nothing written.
- Two concurrent redemptions for the same customer with only enough tickets for one → exactly one succeeds.
- Two concurrent redemptions for the last unit of a prize → exactly one succeeds.
- Idempotency: the same key sent twice creates one sale.
- Transfer dispatch → receive round trip preserves total quantity and total cost across the two shops.

**Permission tests (one per role per endpoint — generate them in a loop)**

- STAFF cannot reach any report, admin or cost endpoint.
- MANAGER cannot reach a shop outside their assignments, by direct ID.
- **No plain MANAGER or STAFF response body, on any endpoint including CSV exports and error payloads, contains a cost value.**
- A **Purchasing** manager sees cost for an assigned shop, and receives `403` for an unassigned one.
- A Purchasing manager still receives `403` on profit, margin and all-shops endpoints — the permission unlocks cost entry, not profitability.
- `POST /api/stock/batches` with a `unitCogs` field from a non-Purchasing manager returns `403` rather than silently dropping the field.
- Adding a 12th shop requires no code change: a test creates shops programmatically up to 12 and asserts pickers, dashboards and reports still resolve.

**Manual acceptance checklist**

- Record 20 sales on a real tablet, on real shop wifi, and time them.
- Complete a clock-in on the actual devices staff will use, with location both granted and denied.
- Perform a full restore onto a second machine and verify against the manifest.
- Have one staff member use the app for a full shift without training, and note every place they hesitate.

---

## 16. Build phases

Build in this order. **Do not begin a phase until the previous phase's acceptance criteria pass.** Each phase should end in a working, deployable app.

### Phase 0 — Foundation ✅ *complete, 4 Aug 2026*
Repo scaffold, Prisma schema and initial migration, seed script, Tailwind, health endpoint.
**Accepted:** `npm run dev` serves the app on `localhost:5050`, showing 2 shops, 1 user and 10 expense categories from the seed.

*As-built notes:* development runs natively on macOS against Homebrew
PostgreSQL 16 — Docker is production-only. The app listens on **5050** (3000
is taken by another project, 5000 by macOS AirPlay Receiver). shadcn/ui is
initialised in Phase 1 rather than Phase 0, when the first components are
actually needed.

### Phase 1 — Auth, roles, work session, app shell *(~1–2 sessions)*
Login, argon2 hashing, DB sessions, role guards, request context, shop assignments, first-login shop picker, app shell with nav and role-based routing, forced password change.
**Accept when:** you can log in as owner/manager/staff, each lands on the right home screen, the shop picker appears once per day, and a staff account is blocked from an admin URL typed directly into the address bar.

### Phase 2 — Sales + customers *(~2 sessions)*
Presets per shop, sale recording with idempotency, walk-in vs identified customer, customer create/search, today's sales list, void with reason, audit logging.
**Accept when:** 20 sales recorded in under 15 seconds each on a tablet, a void reverses correctly, and a double-tap creates exactly one sale.

### Phase 3 — Marble and ticket ledgers *(~1 session)*
Deposit, withdraw, award, adjust. Cached balances written in-transaction. Balance history view. Negative-balance guards. Reconciliation job. Ticket-award controls from §4.6: the "tickets collected?" confirmation, the reason-note threshold, and the Tickets Awarded by Staff report.
**Accept when:** balances survive 50 mixed operations, the reconciliation job reports zero drift, and an award above the threshold cannot be saved without a reason.

### Phase 4 — Prizes, FIFO inventory, redemption *(the hardest phase, ~3 sessions)*
Catalog with global ticket cost, per-shop stocking config, batches, the FIFO engine with its full test suite, redemption cart and transaction, stock movements, low stock flags, the Purchasing permission and cost DTOs, uncosted-batch queue with backfill.
**Accept when:** every FIFO test in §15 passes, a plain manager session provably cannot see a cost value anywhere, a Purchasing manager sees cost only for their own shops, and concurrent redemptions behave correctly.

### Phase 5 — Transfers and opname *(~1–2 sessions)*
Dispatch/receive/cancel with batch provenance, in-transit reporting, opname sessions with variance handling.
**Accept when:** a transfer round trip conserves both quantity and total cost, and an opname loss appears as shrinkage rather than prize expense.

### Phase 6 — Attendance *(~2 sessions)*
Shifts, red banner, camera capture, server-side watermarking, geolocation, lateness, photo retention job, team attendance reporting.
**Accept when:** a clock-in works on a real tablet with location granted and denied, the watermark is legible, the banner behaves exactly as specified, and lateness is correct at the grace boundary.

### Phase 7 — Expenses *(~1 session)*
Categories with the delete-if-unused rule, expense CRUD, receipt upload, expense reporting.
**Accept when:** deleting a used category returns a clear refusal with the usage count.

### Phase 8 — Dashboards and reports *(~2 sessions)*
Owner all-shop dashboard, manager single-shop dashboard, every report in §9, CSV exports, role scoping on all of them.
**Accept when:** every metric in §9 matches a hand-calculation against the demo dataset.

### Phase 9 — Backup, restore, hardening *(~1–2 sessions)*
Backup job, retention, manifest, checksums, restore script, USB drive copy, owner backup screen with one-tap export and the "I copied this off-machine" log, escalating staleness alerts, weekly reminder job, rate limiting, audit log viewer.
**Accept when:** a full restore onto a clean machine reproduces the system exactly, verified against the manifest — **and you have personally rehearsed it once, start to finish.**

### Phase 10 — Polish and pilot *(~1–2 sessions)*
Responsive pass on real devices, loading and empty states, error copy in plain language, printable receipts, PWA manifest, then a one-branch pilot for a week before rolling out to all branches.

**Rollout advice:** run one branch on the app *and* paper for one week. Reconcile daily. Only then roll out to the rest.

---

## 17. Prompts for the coding agent

Paste this at the start of every session:

> Read `CLAUDE.md`, then `docs/BUILD-LOG.md`, then `docs/PRD.md` in full before writing any code — in that order. Where the build log disagrees with this PRD, **the build log wins**; where either disagrees with `prisma/schema.prisma`, the schema wins. We are building phase **N** only — do not implement features from later phases. Follow the stack in §5.2 exactly; do not substitute libraries. All business logic goes in `src/server/services/`; route handlers only authenticate, validate with Zod, and call a service. Every role check is enforced server-side. Money is `Decimal`, never `float`. When a requirement in the PRD is ambiguous, stop and ask me rather than guessing.

> **There is one PRD, and it is `docs/PRD.md`.** A stale copy called
> `PRD-pinball-arcade-management.md` sat in the repo root until 7 Aug 2026 and
> was deleted. It still described per-shop `dayStartHour` at 06:00 (superseded
> by BUILD-LOG D-18 — global, 04:00), hand-rolled sessions with `passwordHash`
> and `isActive` on `User` (superseded by §5.4 — Better Auth, `banned`), and
> shadcn without Base UI (superseded by §5.7). If a copy of it reappears,
> delete it rather than reconciling it.

Per-phase openers:

- **Phase 0:** "Scaffold the project per §5.3 and §12.1, create `prisma/schema.prisma` exactly as written in §6, generate the initial migration, and write the seed script from §10. Nothing else."
- **Phase 4:** "Implement the FIFO inventory engine in `src/server/services/inventory.ts` per §4.8. Write the ten unit tests from §15 first, then make them pass. Do not build any UI yet."
- **Phase 5:** "Implement transfers per §4.10 and opname per §4.11, in `src/server/services/transfers.ts` and `opname.ts`. **Call the existing engine in `inventory.ts` — do not reimplement any FIFO or cost arithmetic.** Dispatch consumes at source via `consumeFifo`; cancel restores via `restoreConsumption`, which already refuses a double restore (BUILD-LOG D-27) — do not add a second restore path. Receive creates **one destination batch per source batch consumed**, preserving both `unitCogs` and the original `receivedAt`, or FIFO order goes wrong globally in a way that only shows up after a later transfer (§4.10, and the mutation in D-30). A positive opname variance is priced with `weightedAverageCost()`, which is built and tested (§15.8) but has had no caller until now; a negative variance consumes FIFO as `OPNAME_LOSS`, never `REDEEM`. Opname must not reveal the system count until counted quantities are entered. Then add the **Transfers** and **Opname** tabs to `stock-tabs.tsx` (D-35) — the array is built from a list, so this is additive."
- **Phase 6:** "Implement attendance per §4.13 to §4.15. The photo must be watermarked server-side with sharp — the client never produces the watermark. Gallery upload must be blocked."
- **Phase 7:** "Implement expenses per §4.12 and §7.6, in `src/server/services/expenses.ts`. The delete-if-unused rule is the acceptance criterion: deleting a category with expense rows returns **409 `CATEGORY_IN_USE` with the usage count**, never a silent archive — the count is what makes the refusal actionable. A category with zero rows deletes outright; one with rows can only be archived. Expenses are shop-scoped and `businessDate` is server-computed (§4.2, D-18) like every other dated row; the client never sends it. **HQ is the one shop that accepts expenses but no sales** (`isHqPseudoShop`), so do not reuse a sale-shop guard here — Phase 5's transfer code deliberately refuses HQ, and expenses must do the opposite. Receipt photos reuse `attendance-photo.ts`'s storage shape but **not** its watermarking: a receipt is evidence of a purchase, not of a person's location. Amount is `Decimal` and crosses the wire as a string (D-13)."

Guardrails worth repeating to the agent when it drifts:

- "Do not add a `qtyOnHand` column. On-hand is always summed from batches."
- "Do not use Server Actions for mutations. Use route handlers."
- "Do not send cost fields to a manager. Use the restricted DTO builder."
- "Do not use `prisma db push`. Generate a migration."

---

## 18. Decision log

All eight open questions were resolved by the owner on **3 August 2026**. Nothing is blocking the build.

| # | Question | Decision | Consequences in this doc |
|---|---|---|---|
| 1 | Marble count per price tier | **Not tracked.** A sale records money only. | `marbleCount` removed from `SalePreset` and `Sale`; "Marbles sold" metric dropped. §4.3, §4.5, §6, §9 |
| 2 | How ticket counts reach the app | **Physical tickets, collected by staff and keyed in.** | Tickets must be destroyed at entry; three anti-fraud controls added. §4.6, §9 |
| 3 | Marble balance expiry | **No expiry.** | `EXPIRE` deliberately absent from the enum. §4.5, §4.6 |
| 4 | Ticket price per branch | **One global price for every branch.** | `ticketCost` moved from `ShopPrizeConfig` to `PrizeItem`. §4.8, §6, §7.4 |
| 5 | Who enters prize cost | **Owner, plus one trusted manager holding a Purchasing permission.** | `UserShop.canEnterCost` (per-shop, D-122); scoped to that manager's own shops; grants cost entry, not profitability. §3.4, §7.5 |
| 6 | Number of shops and staff | **Unlimited and growing.** No fixed count anywhere. | New §5.6 growth rules; seed creates one shop; self-service branch creation with preset/shift cloning. |
| 7 | Receipt printing | **Not in v1.** | On-screen confirmation the customer can screenshot; no thermal printer in the hardware spec. §8.2, §8.6 |
| 8 | Off-machine backup | **Local backups only; owner copies to cloud manually.** | Export button, copy log, escalating dashboard alert, weekly reminder. Automation stays a ten-line change if you change your mind. §13.4 |

### Corrections made during the build

Recorded here so the reasoning survives, and so nobody re-introduces the
original design thinking it was an oversight.

| # | Date | Issue | Resolution |
|---|---|---|---|
| C-1 | 4 Aug 2026 | **`dayStartHour` was per-shop, which is unimplementable.** A `WorkSession` is keyed on `(userId, businessDate)`, but the business date must be known *before* the user picks a shop — so for a multi-shop user there was no `dayStartHour` to compute it from. Caught by the implementing agent before any code was written. | Made global: `AppSetting["businessDayStartHour"]`, seeded to 6. `Shop.dayStartHour` dropped. `lateGraceMin` stays per-shop — no circularity there. §4.2, §6 |
| C-2 | 4 Aug 2026 | **shadcn/ui was listed as a dependency**, but it is a CLI code generator, not a runtime package. | Clarified in §5.2. Initialised at the start of Phase 1, components added per phase as needed rather than bulk-installed. |
| C-3 | 4 Aug 2026 | Port `3000` was assumed free; it is used by another project, and `5000` is claimed by macOS AirPlay Receiver. | App listens on **5050** in dev and production. |
| C-4 | 4 Aug 2026 | Dev environment assumed Docker for Postgres; the Mac already runs Homebrew PostgreSQL 16. | Dev is native against Homebrew Postgres. Docker is production-only, plus a `docker compose build` check each phase to catch filename-case bugs that macOS hides. §12 |
| C-5 | 4 Aug 2026 | **Auth was specified as hand-rolled sessions.** Wrong call — auth is where subtle security bugs live, and an agent writing session handling from scratch is more risk than a maintained library. | **Better Auth** with the Prisma, `username` and `admin` plugins. Self-hosted library, not a service. Hand-rolled `Session` model and password fields removed from §6. §5.4 |
| C-6 | 4 Aug 2026 | shadcn's stock button scale starts at `h-8` (32px), below the 44px floor in NF-3. | Normative size scale added to §8.11; retuned in `button.tsx` rather than forced by a global CSS override, which would have broken icon buttons. |
| C-7 | 4 Aug 2026 | Better Auth requires a unique non-null `email`; the spec says no email addresses exist. | Synthetic `${username}@marblehouse.invalid`, generated server-side, never shown, never editable. Usernames immutable. Column stays non-null. §5.4 |
| C-8 | 4 Aug 2026 | `User.isActive` duplicated the admin plugin's `banned` flag — two sources of truth for "can this person log in". | `banned` is the stored truth (enforced at the session layer); `isActive` is derived in the DTO. UI never says "ban". `isActive` on Shop/Customer/PrizeItem is unaffected. §5.4 |
| C-9 | 4 Aug 2026 | **C-1 was never actually applied to the code.** `Shop.dayStartHour` survived the Phase 0 schema and was what Phases 1–2 read, so the global setting in §4.2 existed on paper only. Found during Phase 2; harmless at the time because every shop was seeded to the same hour. | Column dropped, boundary moved to `AppSetting["businessDayStartHour"]` and read via `getBusinessDayStartHour()`. Owner set it to **04:00** after confirming no branch trades past 23:59. Migration carries an existing database's value forward rather than resetting it. §4.2, BUILD-LOG D-17/D-18 |

### Things to decide later, not now

These emerged from the decisions above. None blocks any phase.

- **Ticket award threshold** *(set during Phase 3)* — the reason-note threshold defaults to 500 tickets. Tune it once you see real award sizes.
- **Whether managers should be able to change the global ticket price at all** *(revisit after Phase 4)* — it is currently allowed with a warning and an owner alert, because your original brief asked for it. One permission flag flips it. §4.8
- **Marble liability review** *(six months after launch)* — with no expiry, stored marbles only accumulate. Watch the dashboard number and decide then whether it needs a policy.
- **Automating the off-machine backup** *(revisit at 3+ branches)* — the cost of a loss scales with the business; the discipline does not. §13.4

---

## 19. Requirements traceability

Confirming every numbered item from the original brief is covered.

| Your requirement | Covered in |
|---|---|
| 1. Record sales (amount, customer, phone, cash/EDC, date/time, staff) | §4.3, §7.2, §8.2 |
| 1.1 Fixed presets, editable per shop; optional customer; phone book lookup | §4.3, §4.4, §8.2, §7.9 · *amounts only — no marble count per §18.1* |
| 2. Store unused marbles, usable across branches | §4.5, §7.3 |
| 3. Store tickets, redeemable later at any branch | §4.6, §7.3 |
| 4. Per-branch prize stock, ticket cost, redeem checkout, auto-deduct, min stock | §4.8, §4.9, §7.4, §8.6, §8.7 |
| 4.1 Prize migration between branches | §4.10, §7.4, §8.7 |
| 4.2 Prize name, COGS, ticket cost, low-stock threshold, batches, FIFO expense | §4.8, §6 (`PrizeBatch`, `StockConsumption`), §9 |
| 5. Reporting: revenue, customer spend, value of prizes spent | §9, §8.3 |
| 6. Full system backup, 02:00 daily, 7-day retention, full restore | §11, §13 |
| 7. Three roles with different access | §3, §3.4 |
| 7.1 Choose shop on first login daily, changeable in settings | §4.7, §8.1, §8.10 |
| 7.2 Owner all-access; manager shop-scoped and cost-blind; staff operational only | §3.4, §7.5 |
| 7.3 Attendance for staff and managers | §4.13, §8.9 |
| 7.3.1 Red banner until clock-in; photo watermarked with date/time/geolocation | §4.13, §8.9 |
| 7.3.2 Shifts per shop, late marking, 5-minute grace | §4.14, §4.13 |
| 7.3.3 Owner attendance metrics and per-staff graphs | §8.9, §9 |
| 7.4 Manager sees one shop at a time | §3.4, §8.4 |
| 7.5 Owner all-shop view | §8.3 |
| 7.6 Attendance photos kept 61 days, then purged daily | §4.15, §11 |
| 8. Expenses with fixed categories (removable only if unused) and notes | §4.12, §7.6, §8.8 |
| 9. Customer profile with useful metrics | §8.5, §9 |
| 9.1 Manager/staff see only name, phone, marbles, tickets | §3.4, §8.5 |
| 10. Owner dashboard: today, total customers, last 30 days, this month | §8.3 |
| 10.1 Staff and manager default to the sale screen | §8.0, §8.1 |
| 11. Tablet-first adaptive web app, also works on phone | §8.11, NF-3 |
| Postgres + Node + Prisma 6 + Cloudflare Tunnel, Windows host, portable to Linux/Pi, no Vercel | §5.2, §12 |
| Unlimited branches, managers and staff added as the business grows | §5.6, §10 |
| Purchasing permission for one trusted manager | §7.5, §3.4 |

---

*End of document.*




