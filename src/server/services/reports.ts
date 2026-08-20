/**
 * The reporting engine (PRD §9) — every metric in one place.
 *
 * §9 exists because "revenue" meant three different things on paper. Each
 * function here implements exactly one row of that table, and the definition is
 * quoted above it. If a screen wants a number, it calls this file; a screen
 * that does its own arithmetic is how two pages start disagreeing.
 *
 * THREE RULES THIS FILE IS BUILT AROUND:
 *
 * 1. **Scope is resolved once, in SQL.** `resolveScope()` turns an actor plus
 *    an optional shopId into a concrete list of shop IDs, and every query
 *    filters on it. No caller can widen it by passing a parameter, and nothing
 *    filters in JavaScript (§5.6 — the difference between fast at 30 branches
 *    and falling over).
 *
 * 2. **Cost is a separate function, never a flag.** Anything reading
 *    `unitCogs`, `unitCogsAtConsumption`, `totalCogs` or `cogsTotal` lives
 *    behind `assertCanSeeCost`. A plain manager cannot call these at all, so
 *    there is no partially-populated response to accidentally serialise
 *    (§7.5, §15).
 *
 * 3. **Money stays `Decimal` end to end and leaves as a string** (D-13, §4.1).
 *    No `Number()` on a money column anywhere in this file.
 *
 * Money as JS numbers is the one bug that would make every figure here subtly
 * wrong while still looking plausible, which is why §4.1 forbids it outright.
 */
import { Prisma } from "@prisma/client";
import type { StockMovementType } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/server/auth/context";
import { canSeeCostForShop, hasShopAccess } from "@/server/auth/context";
import { AppError, forbidden } from "@/server/errors";

const ZERO = new Prisma.Decimal(0);

/** Trailing window for blended COGS per ticket (§9). */
const BLENDED_COGS_WINDOW_DAYS = 90;

// ───────────────────────────── INPUT SHAPES ─────────────────────────────

export const reportRangeSchema = z.object({
  shopId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export type ReportRangeInput = z.infer<typeof reportRangeSchema>;

export interface ResolvedScope {
  /** The concrete shops this query may touch. Never empty. */
  shopIds: string[];
  /** True when the actor asked for, and is entitled to, every shop. */
  isAllShops: boolean;
  from: Date;
  to: Date;
}

// ───────────────────────────── SCOPE + GATES ─────────────────────────────

/**
 * Turn an actor plus an optional `shopId` into the shops a query may read.
 *
 * **The manager rule (owner decision, 8 Aug 2026).** §7.8 grants
 * `/api/reports/sales` to managers, but §3.4 says a manager views reports "one
 * shop at a time" and CLAUDE.md forbids managers on all-shops endpoints. That
 * left the unscoped call ambiguous. Resolution: for a MANAGER, **no `shopId`
 * means their work-session shop** — never a cross-shop aggregate.
 *
 * The alternative, 403 on the unscoped form, was rejected: it would refuse a
 * manager loading their own dashboard, which is precisely the D-34 bug class
 * (a permission that depends on whether a parameter is present, wrong on one
 * branch). Both branches are tested — see `reports.test.ts`.
 *
 * A manager with no work session and no explicit shop is a real error rather
 * than a silent empty report, so it throws.
 */
export async function resolveScope(
  actor: Actor,
  input: ReportRangeInput
): Promise<ResolvedScope> {
  const to = input.to ? parseDate(input.to) : actor.businessDate;
  const from = input.from ? parseDate(input.from) : addDays(to, -29);
  if (from > to) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The start date must be on or before the end date."
    );
  }

  if (input.shopId) {
    // An explicit shop is checked against assignments for everyone but the
    // owner. This is what stops a manager reading another branch by ID (R-4).
    if (!hasShopAccess(actor, input.shopId)) {
      throw forbidden("You do not have access to that shop.");
    }
    // `hasShopAccess` returns true for an OWNER on ANY id, including one that
    // does not exist — it answers "may you?", not "is it real?". Without this
    // check a typo in the URL renders a perfectly calm report full of zeroes,
    // which reads as "this branch sold nothing" rather than "no such branch".
    // A manager never reaches here with a bogus id: it would have failed the
    // assignment check above.
    const exists = await prisma.shop.count({ where: { id: input.shopId } });
    if (exists === 0) {
      throw new AppError("NOT_FOUND", "That shop does not exist.");
    }
    return { shopIds: [input.shopId], isAllShops: false, from, to };
  }

  if (actor.isOwner) {
    const shops = await prisma.shop.findMany({ select: { id: true } });
    return { shopIds: shops.map((s) => s.id), isAllShops: true, from, to };
  }

  // MANAGER / STAFF with no explicit shop → their declared shop for today.
  const shopId = actor.workSession?.shopId ?? actor.defaultShopId;
  if (!shopId) {
    throw new AppError(
      "NO_WORK_SESSION",
      "Choose which shop you are working at before opening a report."
    );
  }
  if (!hasShopAccess(actor, shopId)) {
    throw forbidden("You do not have access to that shop.");
  }
  return { shopIds: [shopId], isAllShops: false, from, to };
}

/**
 * Cost gate for a whole scope.
 *
 * A Purchasing manager passes only when EVERY shop in scope is one of theirs —
 * `canSeeCostForShop` per shop, intersected. This is what keeps §7.5's promise
 * that the permission unlocks cost "for their assigned shops only" and never
 * leaks a figure that blends in a branch they do not manage.
 *
 * Profit and margin are owner-only regardless; those callers use
 * `assertOwner` instead, per CLAUDE.md's cost-visibility section.
 */
export function assertCanSeeCost(actor: Actor, scope: ResolvedScope): void {
  // The `every` that makes this correct lives in canSeeCostForScope below —
  // read the note there before touching it (D-62).
  if (!canSeeCostForScope(actor, scope)) {
    throw forbidden("You do not have access to cost figures for these shops.");
  }
}

/**
 * The non-throwing form of `assertCanSeeCost`, for a report whose *rows* a
 * manager may read while its *cost columns* stay owner/Purchasing-only.
 *
 * **`every`, not `some` — for the same reason `assertCanSeeCost` uses it
 * (D-62).** With `some`, a Purchasing manager handed a mixed scope would get a
 * cost figure blended across shops they do not manage. The two functions must
 * agree; if you change one, change both, and re-run the mixed-scope test.
 */
export function canSeeCostForScope(actor: Actor, scope: ResolvedScope): boolean {
  return scope.shopIds.every((id) => canSeeCostForShop(actor, id));
}

function assertOwner(actor: Actor): void {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can view this report.");
  }
}

// ───────────────────────────── SALES METRICS ─────────────────────────────

/** §9: Revenue · Transactions · Unique customers · Average transaction value. */
export interface SalesSummary {
  revenue: string;
  transactions: number;
  uniqueCustomers: number;
  walkInTransactions: number;
  averageTransactionValue: string;
  cash: string;
  edc: string;
}

export async function salesSummary(
  actor: Actor,
  input: ReportRangeInput
): Promise<SalesSummary & { scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  const where = completedSalesWhere(scope);

  const [agg, byMethod, distinctCustomers, walkIns] = await Promise.all([
    prisma.sale.aggregate({ where, _sum: { amount: true }, _count: true }),
    prisma.sale.groupBy({
      by: ["paymentMethod"],
      where,
      _sum: { amount: true },
    }),
    // "Distinct non-null customerId in completed sales for the period" (§9).
    prisma.sale.findMany({
      where: { ...where, customerId: { not: null } },
      distinct: ["customerId"],
      select: { customerId: true },
    }),
    prisma.sale.count({ where: { ...where, customerId: null } }),
  ]);

  const revenue = agg._sum.amount ?? ZERO;
  const transactions = agg._count;

  return {
    scope,
    revenue: revenue.toString(),
    transactions,
    uniqueCustomers: distinctCustomers.length,
    walkInTransactions: walkIns,
    // Guard the divide: an empty period is 0, not NaN or a crash.
    averageTransactionValue:
      transactions > 0
        ? revenue.div(transactions).toDecimalPlaces(2).toString()
        : "0",
    cash: sumFor(byMethod, "CASH").toString(),
    edc: sumFor(byMethod, "EDC").toString(),
  };
}

/** §9 daily series, for the dashboard trend and the Daily Sales Summary report. */
export interface DailySalesRow {
  businessDate: string;
  revenue: string;
  transactions: number;
}

export async function dailySales(
  actor: Actor,
  input: ReportRangeInput
): Promise<{ rows: DailySalesRow[]; scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  const groups = await prisma.sale.groupBy({
    by: ["businessDate"],
    where: completedSalesWhere(scope),
    _sum: { amount: true },
    _count: true,
    orderBy: { businessDate: "asc" },
  });

  return {
    scope,
    rows: groups.map((g) => ({
      businessDate: isoDate(g.businessDate),
      revenue: (g._sum.amount ?? ZERO).toString(),
      transactions: g._count,
    })),
  };
}

/** §9 Sales by Shop. Feeds the owner's "revenue by shop" chart. */
export interface ShopSalesRow {
  shopId: string;
  shopName: string;
  revenue: string;
  transactions: number;
}

export async function salesByShop(
  actor: Actor,
  input: ReportRangeInput
): Promise<{ rows: ShopSalesRow[]; scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  const [groups, shops] = await Promise.all([
    prisma.sale.groupBy({
      by: ["shopId"],
      where: completedSalesWhere(scope),
      _sum: { amount: true },
      _count: true,
    }),
    prisma.shop.findMany({
      where: { id: { in: scope.shopIds } },
      select: { id: true, name: true },
    }),
  ]);
  const nameById = new Map(shops.map((s) => [s.id, s.name]));

  return {
    scope,
    rows: groups
      .map((g) => ({
        shopId: g.shopId,
        shopName: nameById.get(g.shopId) ?? "Unknown shop",
        revenue: (g._sum.amount ?? ZERO).toString(),
        transactions: g._count,
      }))
      // Highest revenue first — the owner's chart takes the top 8 (§5.6).
      .sort((a, b) => new Prisma.Decimal(b.revenue).comparedTo(a.revenue)),
  };
}

/** §9 Sales by Staff. */
export interface StaffSalesRow {
  userId: string;
  displayName: string;
  revenue: string;
  transactions: number;
}

export async function salesByStaff(
  actor: Actor,
  input: ReportRangeInput
): Promise<{ rows: StaffSalesRow[]; scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  const groups = await prisma.sale.groupBy({
    by: ["recordedById"],
    where: completedSalesWhere(scope),
    _sum: { amount: true },
    _count: true,
  });
  const users = await prisma.user.findMany({
    where: { id: { in: groups.map((g) => g.recordedById) } },
    select: { id: true, displayName: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.displayName]));

  return {
    scope,
    rows: groups
      .map((g) => ({
        userId: g.recordedById,
        displayName: nameById.get(g.recordedById) ?? "Unknown user",
        revenue: (g._sum.amount ?? ZERO).toString(),
        transactions: g._count,
      }))
      .sort((a, b) => new Prisma.Decimal(b.revenue).comparedTo(a.revenue)),
  };
}

// ─────────────────────────── TICKETS & LIABILITY ───────────────────────────

/**
 * §9: Outstanding marbles · Outstanding tickets · Tickets awarded / redeemed.
 *
 * Outstanding balances are read from the cached columns, which is what §9
 * specifies (`SUM(Customer.marbleBalance)`). Those caches are written inside
 * the ledger transaction and reconciled nightly (§4.5, D-22), so they are the
 * intended source — but they are global by nature, NOT shop-scoped: a balance
 * belongs to a customer, not a branch (§4.5 "balances are global across all
 * branches"). Awarded/redeemed counts, by contrast, DO scope by shop, because
 * a ledger row records where the liability was created.
 *
 * Reporting a shop-scoped "outstanding" figure would be inventing a number the
 * business does not have.
 */
export interface LiabilityReport {
  outstandingMarbles: number;
  outstandingTickets: number;
  ticketsAwarded: number;
  ticketsRedeemed: number;
  /** Owner only — needs prize expense, which is a cost figure. */
  blendedCogsPerTicket: string | null;
  estimatedTicketLiability: string | null;
}

export async function liabilityReport(
  actor: Actor,
  input: ReportRangeInput
): Promise<LiabilityReport & { scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);

  const [balances, awarded, redeemed] = await Promise.all([
    prisma.customer.aggregate({
      where: { isActive: true, mergedIntoId: null },
      _sum: { marbleBalance: true, ticketBalance: true },
    }),
    prisma.ticketLedger.aggregate({
      where: { type: "AWARD", ...ledgerWhere(scope) },
      _sum: { delta: true },
    }),
    prisma.ticketLedger.aggregate({
      where: { type: "REDEEM", ...ledgerWhere(scope) },
      _sum: { delta: true },
    }),
  ]);

  const outstandingTickets = balances._sum.ticketBalance ?? 0;

  // The valued half of this report is cost-derived, so it is owner-only. A
  // manager gets the quantities and nulls for the money (§8.4 strips every
  // liability VALUE figure, not the counts).
  let blendedCogsPerTicket: string | null = null;
  let estimatedTicketLiability: string | null = null;
  if (actor.isOwner) {
    const blended = await blendedCogsPerTicketValue(scope);
    blendedCogsPerTicket = blended.toDecimalPlaces(4).toString();
    estimatedTicketLiability = blended
      .mul(outstandingTickets)
      .toDecimalPlaces(2)
      .toString();
  }

  return {
    scope,
    outstandingMarbles: balances._sum.marbleBalance ?? 0,
    outstandingTickets,
    ticketsAwarded: awarded._sum.delta ?? 0,
    // Stored as a negative delta; §9 defines the metric as ABS.
    ticketsRedeemed: Math.abs(redeemed._sum.delta ?? 0),
    blendedCogsPerTicket,
    estimatedTicketLiability,
  };
}

/**
 * §9: "Prize expense ÷ tickets redeemed, over the trailing 90 days."
 *
 * Deliberately NOT bounded by the report's own date range — the metric is
 * defined on a trailing 90-day window, so a user viewing a single day still
 * gets a stable blended rate rather than one computed from one day of noise.
 */
async function blendedCogsPerTicketValue(
  scope: ResolvedScope
): Promise<Prisma.Decimal> {
  const windowFrom = addDays(scope.to, -(BLENDED_COGS_WINDOW_DAYS - 1));
  const windowScope: ResolvedScope = { ...scope, from: windowFrom };

  const [expense, redeemed] = await Promise.all([
    prizeExpenseValue(windowScope),
    prisma.ticketLedger.aggregate({
      where: { type: "REDEEM", ...ledgerWhere(windowScope) },
      _sum: { delta: true },
    }),
  ]);

  const tickets = Math.abs(redeemed._sum.delta ?? 0);
  // No redemptions in the window → no basis for a rate. Zero, not a divide by
  // zero, and not a guess.
  return tickets > 0 ? expense.div(tickets) : ZERO;
}

// ──────────────────────────── COST-GATED METRICS ────────────────────────────

/**
 * §9 Prize expense (COGS): `SUM(StockConsumption.qty × unitCogsAtConsumption)`
 * for movements of type REDEEM.
 *
 * **This is a sum of recorded rows, never a recomputed average** (CLAUDE.md).
 * The cost was captured at the instant of consumption; re-deriving it later
 * from current batch costs would silently restate history.
 *
 * Internal — takes a scope, not an actor. Every exported caller gates first.
 */
async function prizeExpenseValue(scope: ResolvedScope): Promise<Prisma.Decimal> {
  return consumptionValue(scope, ["REDEEM"]);
}

/**
 * §9 Shrinkage expense: the same sum for OPNAME_LOSS and DAMAGE.
 *
 * Reported separately from prize expense on purpose — §9 is explicit that
 * "mixing it into prize expense hides theft". Do not merge these two.
 */
async function shrinkageExpenseValue(
  scope: ResolvedScope
): Promise<Prisma.Decimal> {
  return consumptionValue(scope, ["OPNAME_LOSS", "DAMAGE"]);
}

async function consumptionValue(
  scope: ResolvedScope,
  types: StockMovementType[]
): Promise<Prisma.Decimal> {
  const rows = await prisma.stockConsumption.findMany({
    where: {
      movement: {
        type: { in: types },
        shopId: { in: scope.shopIds },
        businessDate: { gte: scope.from, lte: scope.to },
      },
    },
    select: { qty: true, unitCogsAtConsumption: true },
  });

  // Decimal throughout — a float sum here would be wrong in the last rupiah
  // and nobody would ever notice (§4.1).
  return rows.reduce(
    (total, row) => total.add(row.unitCogsAtConsumption.mul(row.qty)),
    ZERO
  );
}

export interface PrizeExpenseReport {
  prizeExpense: string;
  shrinkageExpense: string;
  byItem: {
    prizeItemId: string;
    prizeName: string;
    qty: number;
    expense: string;
  }[];
}

export async function prizeExpenseReport(
  actor: Actor,
  input: ReportRangeInput
): Promise<PrizeExpenseReport & { scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  assertCanSeeCost(actor, scope);

  const [prizeExpense, shrinkageExpense, rows] = await Promise.all([
    prizeExpenseValue(scope),
    shrinkageExpenseValue(scope),
    prisma.stockConsumption.findMany({
      where: {
        movement: {
          type: "REDEEM",
          shopId: { in: scope.shopIds },
          businessDate: { gte: scope.from, lte: scope.to },
        },
      },
      select: {
        qty: true,
        unitCogsAtConsumption: true,
        movement: { select: { prizeItemId: true } },
      },
    }),
  ]);

  const byItem = new Map<string, { qty: number; expense: Prisma.Decimal }>();
  for (const row of rows) {
    const key = row.movement.prizeItemId;
    const current = byItem.get(key) ?? { qty: 0, expense: ZERO };
    byItem.set(key, {
      qty: current.qty + row.qty,
      expense: current.expense.add(row.unitCogsAtConsumption.mul(row.qty)),
    });
  }

  const items = await prisma.prizeItem.findMany({
    where: { id: { in: [...byItem.keys()] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(items.map((i) => [i.id, i.name]));

  return {
    scope,
    prizeExpense: prizeExpense.toString(),
    shrinkageExpense: shrinkageExpense.toString(),
    byItem: [...byItem.entries()]
      .map(([prizeItemId, v]) => ({
        prizeItemId,
        prizeName: nameById.get(prizeItemId) ?? "Unknown prize",
        qty: v.qty,
        expense: v.expense.toString(),
      }))
      .sort((a, b) => new Prisma.Decimal(b.expense).comparedTo(a.expense)),
  };
}

/**
 * §9 Shrinkage Report — where stock went missing, and how.
 *
 * `prizeExpenseReport` already returns the shrinkage *total*, and that total is
 * what P&L consumes. This report exists because a single number cannot answer
 * the question it raises: §9 keeps shrinkage separate from prize expense
 * precisely because "mixing it into prize expense hides theft" — but a lone
 * total hides it almost as well. One branch losing the same item every week is
 * a different problem from occasional breakage spread across everything, and
 * they are indistinguishable until the figure is broken down.
 *
 * **The OPNAME_LOSS / DAMAGE split is the point, not decoration.** They are
 * different events: DAMAGE is *declared* by someone at the moment it happens,
 * OPNAME_LOSS is *discovered* at a physical count with nobody's name against
 * it. A branch whose shrinkage is all opname loss is the one worth visiting.
 * Do not collapse these into one column.
 *
 * Cost-bearing, so it is gated exactly like `prizeExpenseReport` — via
 * `assertCanSeeCost`, which intersects EVERY shop in scope (D-62's `every`, not
 * `some`).
 */
export interface ShrinkageReport {
  totalShrinkage: string;
  opnameLoss: string;
  damage: string;
  totalUnits: number;
  byItem: {
    prizeItemId: string;
    prizeName: string;
    qty: number;
    opnameLossValue: string;
    damageValue: string;
    value: string;
  }[];
  byShop: {
    shopId: string;
    shopName: string;
    qty: number;
    value: string;
  }[];
}

export async function shrinkageReport(
  actor: Actor,
  input: ReportRangeInput
): Promise<ShrinkageReport & { scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  assertCanSeeCost(actor, scope);

  const rows = await prisma.stockConsumption.findMany({
    where: {
      movement: {
        type: { in: ["OPNAME_LOSS", "DAMAGE"] },
        shopId: { in: scope.shopIds },
        businessDate: { gte: scope.from, lte: scope.to },
      },
    },
    select: {
      qty: true,
      unitCogsAtConsumption: true,
      movement: { select: { prizeItemId: true, shopId: true, type: true } },
    },
  });

  // Decimal arithmetic throughout (§4.1). Every accumulator starts at ZERO and
  // is only ever `.add()`ed — never converted to a number for summing.
  let opnameLoss = ZERO;
  let damage = ZERO;
  let totalUnits = 0;

  const byItem = new Map<
    string,
    { qty: number; opname: Prisma.Decimal; damage: Prisma.Decimal }
  >();
  const byShop = new Map<string, { qty: number; value: Prisma.Decimal }>();

  for (const row of rows) {
    const value = row.unitCogsAtConsumption.mul(row.qty);
    const isDamage = row.movement.type === "DAMAGE";

    if (isDamage) damage = damage.add(value);
    else opnameLoss = opnameLoss.add(value);
    totalUnits += row.qty;

    const itemKey = row.movement.prizeItemId;
    const item = byItem.get(itemKey) ?? { qty: 0, opname: ZERO, damage: ZERO };
    byItem.set(itemKey, {
      qty: item.qty + row.qty,
      opname: isDamage ? item.opname : item.opname.add(value),
      damage: isDamage ? item.damage.add(value) : item.damage,
    });

    const shopKey = row.movement.shopId;
    const shop = byShop.get(shopKey) ?? { qty: 0, value: ZERO };
    byShop.set(shopKey, {
      qty: shop.qty + row.qty,
      value: shop.value.add(value),
    });
  }

  const [items, shops] = await Promise.all([
    prisma.prizeItem.findMany({
      where: { id: { in: [...byItem.keys()] } },
      select: { id: true, name: true },
    }),
    prisma.shop.findMany({
      where: { id: { in: [...byShop.keys()] } },
      select: { id: true, name: true },
    }),
  ]);
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const shopName = new Map(shops.map((s) => [s.id, s.name]));

  return {
    scope,
    totalShrinkage: opnameLoss.add(damage).toString(),
    opnameLoss: opnameLoss.toString(),
    damage: damage.toString(),
    totalUnits,
    // Sorted by value lost, descending: the worst item is the one the owner
    // opened this screen to find, so it goes at the top.
    byItem: [...byItem.entries()]
      .map(([prizeItemId, v]) => ({
        prizeItemId,
        prizeName: itemName.get(prizeItemId) ?? "Unknown prize",
        qty: v.qty,
        opnameLossValue: v.opname.toString(),
        damageValue: v.damage.toString(),
        value: v.opname.add(v.damage).toString(),
      }))
      .sort((a, b) => new Prisma.Decimal(b.value).comparedTo(a.value)),
    byShop: [...byShop.entries()]
      .map(([shopId, v]) => ({
        shopId,
        shopName: shopName.get(shopId) ?? "Unknown shop",
        qty: v.qty,
        value: v.value.toString(),
      }))
      .sort((a, b) => new Prisma.Decimal(b.value).comparedTo(a.value)),
  };
}

/**
 * §9 Prize Redemption Report — what customers actually took home.
 *
 * Deliberately **not** cost-gated at the top. Quantities, ticket spend and
 * redemption counts are operational facts a manager needs to restock, and §7.5
 * restricts *cost*, not activity. So the cost fields are resolved per-caller
 * instead: `canSeeCost` decides whether `cogs` is populated at all, and the
 * restricted branch never reads `unitCogsAtConsumption` — the D-63 rule that a
 * DTO and its exporter must branch on the same predicate applies here too.
 *
 * `tickets` comes from `RedemptionLine.ticketCostTotal`, the price snapshotted
 * at redemption — never the prize's current `ticketCost`. The price may have
 * changed since (§4.8 audits exactly that), and this report has to say what the
 * customer actually paid.
 *
 * A voided redemption is excluded (`isVoided: false`), matching how §9 defines
 * revenue as completed sales only. Note `Redemption` uses a boolean rather than
 * the `status` enum `Sale` has — they are not the same shape.
 */
export interface PrizeRedemptionReport {
  redemptions: number;
  itemsGiven: number;
  ticketsSpent: number;
  /** Null for a caller who may not see cost (§7.5). */
  totalCogs: string | null;
  byItem: {
    prizeItemId: string;
    prizeName: string;
    qty: number;
    tickets: number;
    cogs: string | null;
  }[];
}

/**
 * Redemption lines for a scope, with `cogsTotal` present ONLY when permitted.
 *
 * Two separate queries rather than one conditional `select`, because the
 * restricted branch must not name the cost column at all (§7.5) — and because a
 * conditional select object widens the result to `unknown` and would push us
 * toward a cast, which is exactly how a cost field leaks back in.
 *
 * The restricted branch returns `cogsTotal: null`, so every caller has to make
 * a deliberate decision about the null rather than silently summing a zero it
 * mistook for a real figure.
 */
export async function redemptionLinesForScope(
  scope: ResolvedScope,
  withCost: boolean
): Promise<
  { qty: number; ticketCostTotal: number; prizeItemId: string; cogsTotal: Prisma.Decimal | null }[]
> {
  const where = {
    redemption: {
      shopId: { in: scope.shopIds },
      businessDate: { gte: scope.from, lte: scope.to },
      isVoided: false,
    },
  };

  if (withCost) {
    return prisma.redemptionLine.findMany({
      where,
      select: {
        qty: true,
        ticketCostTotal: true,
        prizeItemId: true,
        cogsTotal: true,
      },
    });
  }

  const rows = await prisma.redemptionLine.findMany({
    where,
    select: { qty: true, ticketCostTotal: true, prizeItemId: true },
  });
  return rows.map((r) => ({ ...r, cogsTotal: null }));
}

export async function prizeRedemptionReport(
  actor: Actor,
  input: ReportRangeInput
): Promise<PrizeRedemptionReport & { scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  const withCost = canSeeCostForScope(actor, scope);

  const [redemptionCount, lines] = await Promise.all([
    prisma.redemption.count({
      where: {
        shopId: { in: scope.shopIds },
        businessDate: { gte: scope.from, lte: scope.to },
        isVoided: false,
      },
    }),
    redemptionLinesForScope(scope, withCost),
  ]);

  let itemsGiven = 0;
  let ticketsSpent = 0;
  let totalCogs = ZERO;
  const byItem = new Map<
    string,
    { qty: number; tickets: number; cogs: Prisma.Decimal }
  >();

  for (const line of lines) {
    // ticketCostTotal is ALREADY qty × ticketCostEach — multiplying by qty
    // again would square the quantity and silently inflate every figure here.
    const tickets = line.ticketCostTotal;
    // null on the restricted branch by construction, never a real zero.
    const cogs = line.cogsTotal ?? ZERO;

    itemsGiven += line.qty;
    ticketsSpent += tickets;
    totalCogs = totalCogs.add(cogs);

    const current = byItem.get(line.prizeItemId) ?? {
      qty: 0,
      tickets: 0,
      cogs: ZERO,
    };
    byItem.set(line.prizeItemId, {
      qty: current.qty + line.qty,
      tickets: current.tickets + tickets,
      cogs: current.cogs.add(cogs),
    });
  }

  const items = await prisma.prizeItem.findMany({
    where: { id: { in: [...byItem.keys()] } },
    select: { id: true, name: true },
  });
  const nameById = new Map(items.map((i) => [i.id, i.name]));

  return {
    scope,
    redemptions: redemptionCount,
    itemsGiven,
    ticketsSpent,
    totalCogs: withCost ? totalCogs.toString() : null,
    byItem: [...byItem.entries()]
      .map(([prizeItemId, v]) => ({
        prizeItemId,
        prizeName: nameById.get(prizeItemId) ?? "Unknown prize",
        qty: v.qty,
        tickets: v.tickets,
        cogs: withCost ? v.cogs.toString() : null,
      }))
      // Most-redeemed first: this report's job is to say what is moving.
      .sort((a, b) => b.qty - a.qty),
  };
}

/** §9 Stock value on hand: `SUM(qtyRemaining × unitCogs)` per shop. Owner or Purchasing. */
export interface StockValuationRow {
  shopId: string;
  shopName: string;
  value: string;
  units: number;
}

export async function stockValuation(
  actor: Actor,
  input: ReportRangeInput
): Promise<{ rows: StockValuationRow[]; total: string; scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  assertCanSeeCost(actor, scope);

  // Valuation is a point-in-time figure about stock that exists NOW, so it
  // deliberately ignores the date range. Filtering live batches by a past
  // window would report a number that means nothing.
  const batches = await prisma.prizeBatch.findMany({
    where: { shopId: { in: scope.shopIds }, isVoid: false, qtyRemaining: { gt: 0 } },
    select: { shopId: true, qtyRemaining: true, unitCogs: true },
  });
  const shops = await prisma.shop.findMany({
    where: { id: { in: scope.shopIds } },
    select: { id: true, name: true },
  });
  const nameById = new Map(shops.map((s) => [s.id, s.name]));

  const byShop = new Map<string, { value: Prisma.Decimal; units: number }>();
  for (const b of batches) {
    const current = byShop.get(b.shopId) ?? { value: ZERO, units: 0 };
    byShop.set(b.shopId, {
      value: current.value.add(b.unitCogs.mul(b.qtyRemaining)),
      units: current.units + b.qtyRemaining,
    });
  }

  const rows = [...byShop.entries()]
    .map(([shopId, v]) => ({
      shopId,
      shopName: nameById.get(shopId) ?? "Unknown shop",
      value: v.value.toString(),
      units: v.units,
    }))
    .sort((a, b) => new Prisma.Decimal(b.value).comparedTo(a.value));

  const total = rows.reduce((sum, r) => sum.add(r.value), ZERO);
  return { rows, total: total.toString(), scope };
}

/**
 * §9 Gross profit / Net profit. **OWNER ONLY** — CLAUDE.md is explicit that a
 * Purchasing manager still gets 403 on profit and margin, so this uses
 * `assertOwner` rather than the cost gate.
 */
export interface ProfitRow {
  shopId: string;
  shopName: string;
  revenue: string;
  prizeExpense: string;
  shrinkageExpense: string;
  operatingExpenses: string;
  grossProfit: string;
  netProfit: string;
}

export async function profitReport(
  actor: Actor,
  input: ReportRangeInput
): Promise<{ rows: ProfitRow[]; combined: ProfitRow; scope: ResolvedScope }> {
  assertOwner(actor);
  const scope = await resolveScope(actor, input);

  const shops = await prisma.shop.findMany({
    where: { id: { in: scope.shopIds } },
    select: { id: true, name: true },
  });

  const rows: ProfitRow[] = [];
  for (const shop of shops) {
    const shopScope: ResolvedScope = { ...scope, shopIds: [shop.id] };
    const [revenueAgg, prize, shrink, opex] = await Promise.all([
      prisma.sale.aggregate({
        where: completedSalesWhere(shopScope),
        _sum: { amount: true },
      }),
      prizeExpenseValue(shopScope),
      shrinkageExpenseValue(shopScope),
      operatingExpensesValue(shopScope),
    ]);

    const revenue = revenueAgg._sum.amount ?? ZERO;
    const gross = revenue.sub(prize).sub(shrink);
    rows.push({
      shopId: shop.id,
      shopName: shop.name,
      revenue: revenue.toString(),
      prizeExpense: prize.toString(),
      shrinkageExpense: shrink.toString(),
      operatingExpenses: opex.toString(),
      grossProfit: gross.toString(),
      netProfit: gross.sub(opex).toString(),
    });
  }

  rows.sort((a, b) => new Prisma.Decimal(b.revenue).comparedTo(a.revenue));

  // Combined is summed from the per-shop rows rather than re-queried, so the
  // total and its parts can never disagree on screen.
  const combined = rows.reduce<ProfitRow>(
    (acc, r) => ({
      ...acc,
      revenue: new Prisma.Decimal(acc.revenue).add(r.revenue).toString(),
      prizeExpense: new Prisma.Decimal(acc.prizeExpense).add(r.prizeExpense).toString(),
      shrinkageExpense: new Prisma.Decimal(acc.shrinkageExpense)
        .add(r.shrinkageExpense)
        .toString(),
      operatingExpenses: new Prisma.Decimal(acc.operatingExpenses)
        .add(r.operatingExpenses)
        .toString(),
      grossProfit: new Prisma.Decimal(acc.grossProfit).add(r.grossProfit).toString(),
      netProfit: new Prisma.Decimal(acc.netProfit).add(r.netProfit).toString(),
    }),
    {
      shopId: "ALL",
      shopName: "All shops",
      revenue: "0",
      prizeExpense: "0",
      shrinkageExpense: "0",
      operatingExpenses: "0",
      grossProfit: "0",
      netProfit: "0",
    }
  );

  return { rows, combined, scope };
}

/** §9 Operating expenses: `SUM(Expense.amount)` where not deleted. */
async function operatingExpensesValue(
  scope: ResolvedScope
): Promise<Prisma.Decimal> {
  const agg = await prisma.expense.aggregate({
    where: {
      shopId: { in: scope.shopIds },
      isDeleted: false,
      businessDate: { gte: scope.from, lte: scope.to },
    },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? ZERO;
}

export interface ExpenseReportRow {
  categoryId: string;
  categoryName: string;
  amount: string;
  count: number;
}

export async function expenseReport(
  actor: Actor,
  input: ReportRangeInput
): Promise<{ rows: ExpenseReportRow[]; total: string; scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  const groups = await prisma.expense.groupBy({
    by: ["categoryId"],
    where: {
      shopId: { in: scope.shopIds },
      isDeleted: false,
      businessDate: { gte: scope.from, lte: scope.to },
    },
    _sum: { amount: true },
    _count: true,
  });
  const categories = await prisma.expenseCategory.findMany({
    where: { id: { in: groups.map((g) => g.categoryId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const rows = groups
    .map((g) => ({
      categoryId: g.categoryId,
      categoryName: nameById.get(g.categoryId) ?? "Unknown category",
      amount: (g._sum.amount ?? ZERO).toString(),
      count: g._count,
    }))
    .sort((a, b) => new Prisma.Decimal(b.amount).comparedTo(a.amount));

  const total = rows.reduce((sum, r) => sum.add(r.amount), ZERO);
  return { rows, total: total.toString(), scope };
}

// ──────────────────────────── CUSTOMERS ────────────────────────────

/** §9 Customer lifetime value · Active days · Preferred shop. OWNER only (§3.4). */
export interface CustomerReportRow {
  customerId: string;
  name: string;
  phone: string;
  lifetimeValue: string;
  transactions: number;
  activeDays: number;
  marbleBalance: number;
  ticketBalance: number;
  lastSeenAt: string;
}

export async function customerReport(
  actor: Actor,
  input: ReportRangeInput & { limit?: number }
): Promise<{ rows: CustomerReportRow[]; scope: ResolvedScope }> {
  assertOwner(actor);
  const scope = await resolveScope(actor, input);
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);

  const groups = await prisma.sale.groupBy({
    by: ["customerId"],
    where: { ...completedSalesWhere(scope), customerId: { not: null } },
    _sum: { amount: true },
    _count: true,
    orderBy: { _sum: { amount: "desc" } },
    take: limit,
  });

  const customerIds = groups
    .map((g) => g.customerId)
    .filter((id): id is string => id !== null);

  const [customers, activeDayRows] = await Promise.all([
    prisma.customer.findMany({
      where: { id: { in: customerIds } },
      select: {
        id: true,
        name: true,
        phoneRaw: true,
        marbleBalance: true,
        ticketBalance: true,
        lastSeenAt: true,
      },
    }),
    // Active days = distinct businessDate with at least one completed sale (§9).
    prisma.sale.findMany({
      where: { ...completedSalesWhere(scope), customerId: { in: customerIds } },
      distinct: ["customerId", "businessDate"],
      select: { customerId: true },
    }),
  ]);

  const customerById = new Map(customers.map((c) => [c.id, c]));
  const activeDaysById = new Map<string, number>();
  for (const row of activeDayRows) {
    if (!row.customerId) continue;
    activeDaysById.set(row.customerId, (activeDaysById.get(row.customerId) ?? 0) + 1);
  }

  return {
    scope,
    rows: groups.flatMap((g) => {
      if (!g.customerId) return [];
      const c = customerById.get(g.customerId);
      if (!c) return [];
      return [
        {
          customerId: g.customerId,
          name: c.name,
          phone: c.phoneRaw,
          lifetimeValue: (g._sum.amount ?? ZERO).toString(),
          transactions: g._count,
          activeDays: activeDaysById.get(g.customerId) ?? 0,
          marbleBalance: c.marbleBalance,
          ticketBalance: c.ticketBalance,
          lastSeenAt: c.lastSeenAt.toISOString(),
        },
      ];
    }),
  };
}

// ──────────────────────────── ATTENDANCE ────────────────────────────

/** §9 Late rate (staff) · Attendance rate. */
export interface AttendanceReportRow {
  userId: string;
  displayName: string;
  records: number;
  lateCount: number;
  lateRate: string;
  totalLateMinutes: number;
  averageLateMinutes: string;
}

export async function attendanceReport(
  actor: Actor,
  input: ReportRangeInput
): Promise<{
  rows: AttendanceReportRow[];
  scope: ResolvedScope;
  totals: { records: number; lateCount: number; lateRate: string };
}> {
  const isManagerSomewhere = [...actor.shopRoles.values()].some(
    (sr) => sr.role === "MANAGER"
  );
  if (!actor.isOwner && !isManagerSomewhere) {
    throw forbidden("Only a manager or the owner can view team attendance.");
  }
  const scope = await resolveScope(actor, input);

  const groups = await prisma.attendance.groupBy({
    by: ["userId"],
    where: {
      shopId: { in: scope.shopIds },
      businessDate: { gte: scope.from, lte: scope.to },
    },
    _count: true,
    _sum: { lateMinutes: true },
  });
  const lateGroups = await prisma.attendance.groupBy({
    by: ["userId"],
    where: {
      shopId: { in: scope.shopIds },
      businessDate: { gte: scope.from, lte: scope.to },
      isLate: true,
    },
    _count: true,
  });
  const users = await prisma.user.findMany({
    where: { id: { in: groups.map((g) => g.userId) } },
    select: { id: true, displayName: true },
  });

  const nameById = new Map(users.map((u) => [u.id, u.displayName]));
  const lateById = new Map(lateGroups.map((g) => [g.userId, g._count]));

  const rows = groups
    .map((g) => {
      const records = g._count;
      const lateCount = lateById.get(g.userId) ?? 0;
      const totalLateMinutes = g._sum.lateMinutes ?? 0;
      return {
        userId: g.userId,
        displayName: nameById.get(g.userId) ?? "Unknown user",
        records,
        lateCount,
        lateRate: ratio(lateCount, records),
        totalLateMinutes,
        averageLateMinutes:
          lateCount > 0
            ? new Prisma.Decimal(totalLateMinutes)
                .div(lateCount)
                .toDecimalPlaces(1)
                .toString()
            : "0",
      };
    })
    .sort((a, b) => Number(b.lateRate) - Number(a.lateRate));

  const totalRecords = rows.reduce((n, r) => n + r.records, 0);
  const totalLate = rows.reduce((n, r) => n + r.lateCount, 0);

  return {
    rows,
    scope,
    totals: {
      records: totalRecords,
      lateCount: totalLate,
      lateRate: ratio(totalLate, totalRecords),
    },
  };
}

// ──────────────────────────── LOW STOCK ────────────────────────────

/** §9 Low Stock. Quantities only — no cost, so every manager may read it. */
export interface LowStockRow {
  shopId: string;
  shopName: string;
  prizeItemId: string;
  prizeName: string;
  onHand: number;
  lowStockThreshold: number;
}

export async function lowStockReport(
  actor: Actor,
  input: ReportRangeInput
): Promise<{ rows: LowStockRow[]; scope: ResolvedScope }> {
  const scope = await resolveScope(actor, input);
  return { rows: await lowStockRowsForScope(scope), scope };
}

/**
 * The low-stock query against an ALREADY-RESOLVED scope.
 *
 * The dashboard holds a resolved scope and must not re-derive a `shopId` from
 * it to call the public function — round-tripping a scope back through
 * `resolveScope` is how the two disagree. Exported for that caller only;
 * anything reached from a route goes through `lowStockReport`, which resolves
 * and permission-checks first.
 */
export async function lowStockRowsForScope(
  scope: ResolvedScope
): Promise<LowStockRow[]> {
  const configs = await prisma.shopPrizeConfig.findMany({
    where: {
      shopId: { in: scope.shopIds },
      isActive: true,
      // Threshold 0 means "no alert" (§4.8) — exclude in SQL rather than
      // fetching every config and filtering after.
      lowStockThreshold: { gt: 0 },
    },
    select: {
      shopId: true,
      prizeItemId: true,
      lowStockThreshold: true,
      shop: { select: { name: true } },
      prizeItem: { select: { name: true } },
    },
  });

  // On-hand is ALWAYS summed from batches — there is no qtyOnHand column and
  // there must never be one (CLAUDE.md).
  const onHandRows = await prisma.prizeBatch.groupBy({
    by: ["shopId", "prizeItemId"],
    where: { shopId: { in: scope.shopIds }, isVoid: false },
    _sum: { qtyRemaining: true },
  });
  const onHandByKey = new Map(
    onHandRows.map((r) => [`${r.shopId}:${r.prizeItemId}`, r._sum.qtyRemaining ?? 0])
  );

  return configs
    .map((c) => ({
      shopId: c.shopId,
      shopName: c.shop.name,
      prizeItemId: c.prizeItemId,
      prizeName: c.prizeItem.name,
      onHand: onHandByKey.get(`${c.shopId}:${c.prizeItemId}`) ?? 0,
      lowStockThreshold: c.lowStockThreshold,
    }))
    .filter((r) => r.onHand <= r.lowStockThreshold)
    .sort((a, b) => a.onHand - b.onHand);
}

// ──────────────────────────── HELPERS ────────────────────────────

/**
 * The revenue filter, in one place.
 *
 * §9: revenue is `status = COMPLETED`, grouped by `businessDate`. A voided sale
 * leaves the total by definition (D-11) — there is no reversing row to net off,
 * so every revenue query MUST carry this status filter or it will count voids.
 */
function completedSalesWhere(scope: ResolvedScope) {
  return {
    status: "COMPLETED" as const,
    shopId: { in: scope.shopIds },
    businessDate: { gte: scope.from, lte: scope.to },
  };
}

function ledgerWhere(scope: ResolvedScope) {
  return {
    shopId: { in: scope.shopIds },
    businessDate: { gte: scope.from, lte: scope.to },
  };
}

function sumFor(
  groups: { paymentMethod: string; _sum: { amount: Prisma.Decimal | null } }[],
  method: string
): Prisma.Decimal {
  return groups.find((g) => g.paymentMethod === method)?._sum.amount ?? ZERO;
}

function ratio(numerator: number, denominator: number): string {
  if (denominator === 0) return "0";
  return new Prisma.Decimal(numerator)
    .div(denominator)
    .toDecimalPlaces(4)
    .toString();
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function parseDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AppError("VALIDATION_FAILED", "That date is not valid.");
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new AppError("VALIDATION_FAILED", "That date is not valid.");
  }
  return date;
}
