/**
 * Reporting engine tests (PRD §9, §15).
 *
 * These use SMALL, HAND-BUILT fixtures where the expected number is obvious by
 * inspection — 3 sales of 10.000 is revenue 30.000, and you can check that
 * without running anything. That is the point: §16 accepts Phase 8 when every
 * metric matches a hand-calculation, and a hand-calculation you cannot do in
 * your head is not a check, it is a second implementation with the same bugs.
 *
 * The demo dataset (`--demo`) is verified separately, by independent SQL in
 * `scripts/verify-phase8.sh`. Two different techniques against the same engine.
 *
 * NOT using `withRollback`: the engine reads the module-level `prisma` client
 * from `@/lib/prisma`, so it cannot see rows written inside a test-owned
 * transaction. Fixtures are committed and removed in `afterEach`, the same
 * approach `opname.test.ts` takes (D-26).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, uniq } from "./helpers";
import type { Actor } from "@/server/auth/context";
import {
  salesSummary,
  dailySales,
  salesByShop,
  liabilityReport,
  prizeExpenseReport,
  stockValuation,
  profitReport,
  expenseReport,
  attendanceReport,
  lowStockReport,
  resolveScope,
  assertCanSeeCost,
} from "@/server/services/reports";
import { getDashboard } from "@/server/services/dashboard";

const DAY = new Date("2026-03-10T00:00:00.000Z");
const YESTERDAY = new Date("2026-03-09T00:00:00.000Z");
const iso = (d: Date) => d.toISOString().slice(0, 10);

let tag: string;
let shopA: string;
let shopB: string;
let ownerId: string;
let managerId: string;
let staffId: string;
let customerId: string;
let prizeId: string;
let categoryId: string;

/** Build an actor by hand — these tests exercise services, not the auth layer. */
function actorFor(
  role: "OWNER" | "MANAGER" | "STAFF",
  opts: {
    userId?: string;
    shopIds?: string[];
    canEnterCost?: boolean;
    workShopId?: string | null;
  } = {}
): Actor {
  const shopIds = opts.shopIds ?? [shopA];
  return {
    sessionId: "test-session",
    userId: opts.userId ?? (role === "OWNER" ? ownerId : managerId),
    username: role.toLowerCase(),
    displayName: `Test ${role}`,
    role,
    isActive: true,
    mustChangePassword: false,
    canEnterCost: opts.canEnterCost ?? false,
    defaultShopId: shopIds[0] ?? null,
    assignedShopIds: shopIds,
    businessDate: DAY,
    workSession:
      opts.workShopId === null
        ? null
        : ({
            id: "ws",
            userId: opts.userId ?? managerId,
            shopId: opts.workShopId ?? shopIds[0]!,
            businessDate: DAY,
            selectedAt: DAY,
            changedCount: 0,
            shop: { id: opts.workShopId ?? shopIds[0]! } as never,
          } as never),
  };
}

beforeEach(async () => {
  tag = uniq();

  const a = await prisma.shop.create({
    data: { code: `R8A-${tag}`, name: `Report A ${tag}`, timezone: "Asia/Jakarta" },
  });
  const b = await prisma.shop.create({
    data: { code: `R8B-${tag}`, name: `Report B ${tag}`, timezone: "Asia/Jakarta" },
  });
  shopA = a.id;
  shopB = b.id;

  const mkUser = async (role: "OWNER" | "MANAGER" | "STAFF", n: string) =>
    (
      await prisma.user.create({
        data: {
          email: `r8-${n}-${tag}@marblehouse.invalid`,
          name: `R8 ${n} ${tag}`,
          displayName: `R8 ${n} ${tag}`,
          username: `r8-${n}-${tag}`,
          role,
        },
      })
    ).id;

  ownerId = await mkUser("OWNER", "owner");
  managerId = await mkUser("MANAGER", "mgr");
  staffId = await mkUser("STAFF", "staff");

  const customer = await prisma.customer.create({
    data: {
      name: `R8 Customer ${tag}`,
      phoneRaw: `+62900${tag}`,
      phoneNormalized: `+62900${tag}`,
      marbleBalance: 40,
      ticketBalance: 300,
    },
  });
  customerId = customer.id;

  const prize = await prisma.prizeItem.create({
    data: { sku: `R8-${tag}`, name: `R8 Prize ${tag}`, ticketCost: 100 },
  });
  prizeId = prize.id;

  const category = await prisma.expenseCategory.create({
    data: { name: `R8 Category ${tag}` },
  });
  categoryId = category.id;
});

afterEach(async () => {
  const shopIds = [shopA, shopB];
  const userIds = [ownerId, managerId, staffId];
  await prisma.stockConsumption.deleteMany({
    where: { movement: { shopId: { in: shopIds } } },
  });
  await prisma.redemptionLine.deleteMany({
    where: { redemption: { shopId: { in: shopIds } } },
  });
  await prisma.redemption.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.stockMovement.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.prizeBatch.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.shopPrizeConfig.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.ticketLedger.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.marbleLedger.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.sale.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.expense.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.attendance.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.customer.deleteMany({ where: { id: customerId } });
  await prisma.prizeItem.deleteMany({ where: { id: prizeId } });
  await prisma.expenseCategory.deleteMany({ where: { id: categoryId } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
});

async function makeSale(args: {
  shopId: string;
  amount: number;
  status?: "COMPLETED" | "VOIDED";
  customerId?: string | null;
  paymentMethod?: "CASH" | "EDC";
  businessDate?: Date;
  userId?: string;
}) {
  return prisma.sale.create({
    data: {
      shopId: args.shopId,
      recordedById: args.userId ?? staffId,
      customerId: args.customerId === undefined ? customerId : args.customerId,
      amount: new Prisma.Decimal(args.amount),
      paymentMethod: args.paymentMethod ?? "CASH",
      status: args.status ?? "COMPLETED",
      businessDate: args.businessDate ?? DAY,
    },
  });
}

/** A batch plus a consumption against it, at a known cost. */
async function consume(args: {
  shopId: string;
  qty: number;
  unitCogs: number;
  type: "REDEEM" | "OPNAME_LOSS" | "DAMAGE";
  businessDate?: Date;
}) {
  const batch = await prisma.prizeBatch.create({
    data: {
      shopId: args.shopId,
      prizeItemId: prizeId,
      qtyReceived: args.qty,
      qtyRemaining: 0,
      unitCogs: new Prisma.Decimal(args.unitCogs),
      receivedAt: DAY,
    },
  });
  const movement = await prisma.stockMovement.create({
    data: {
      shopId: args.shopId,
      prizeItemId: prizeId,
      type: args.type,
      qtyDelta: -args.qty,
      businessDate: args.businessDate ?? DAY,
    },
  });
  await prisma.stockConsumption.create({
    data: {
      movementId: movement.id,
      batchId: batch.id,
      qty: args.qty,
      unitCogsAtConsumption: new Prisma.Decimal(args.unitCogs),
    },
  });
  return movement;
}

const range = { from: iso(DAY), to: iso(DAY) };

// ─────────────────────────── REVENUE ───────────────────────────

describe("salesSummary (§9 revenue, transactions, ATV)", () => {
  it("sums COMPLETED sales and excludes VOIDED ones", async () => {
    await makeSale({ shopId: shopA, amount: 50_000 });
    await makeSale({ shopId: shopA, amount: 30_000 });
    // A void leaves the total by definition (§9, D-11) — there is no reversing
    // row, so a missing status filter would silently inflate revenue by 999999.
    await makeSale({ shopId: shopA, amount: 999_999, status: "VOIDED" });

    const result = await salesSummary(actorFor("OWNER"), { shopId: shopA, ...range });

    expect(result.revenue).toBe("80000");
    expect(result.transactions).toBe(2);
    expect(result.averageTransactionValue).toBe("40000");
  });

  it("counts unique customers and walk-ins separately (§9)", async () => {
    await makeSale({ shopId: shopA, amount: 10_000 });
    await makeSale({ shopId: shopA, amount: 10_000 }); // same customer again
    await makeSale({ shopId: shopA, amount: 10_000, customerId: null });
    await makeSale({ shopId: shopA, amount: 10_000, customerId: null });

    const result = await salesSummary(actorFor("OWNER"), { shopId: shopA, ...range });

    expect(result.uniqueCustomers).toBe(1);
    expect(result.walkInTransactions).toBe(2);
    expect(result.transactions).toBe(4);
  });

  it("splits cash and EDC", async () => {
    await makeSale({ shopId: shopA, amount: 70_000, paymentMethod: "CASH" });
    await makeSale({ shopId: shopA, amount: 25_000, paymentMethod: "EDC" });

    const result = await salesSummary(actorFor("OWNER"), { shopId: shopA, ...range });

    expect(result.cash).toBe("70000");
    expect(result.edc).toBe("25000");
  });

  it("returns zero — not NaN — for an empty period", async () => {
    const result = await salesSummary(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(result.revenue).toBe("0");
    expect(result.averageTransactionValue).toBe("0");
  });

  it("respects the date range boundaries", async () => {
    await makeSale({ shopId: shopA, amount: 11_000, businessDate: YESTERDAY });
    await makeSale({ shopId: shopA, amount: 22_000, businessDate: DAY });

    const onlyToday = await salesSummary(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(onlyToday.revenue).toBe("22000");

    const both = await salesSummary(actorFor("OWNER"), {
      shopId: shopA,
      from: iso(YESTERDAY),
      to: iso(DAY),
    });
    expect(both.revenue).toBe("33000");
  });

  it("keeps money exact — no floating-point artefact (§15)", async () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004. Decimal must give 0.30.
    await makeSale({ shopId: shopA, amount: 0.1 });
    await makeSale({ shopId: shopA, amount: 0.2 });

    const result = await salesSummary(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(result.revenue).toBe("0.3");
  });
});

describe("dailySales / salesByShop", () => {
  it("groups by businessDate in ascending order", async () => {
    await makeSale({ shopId: shopA, amount: 5_000, businessDate: YESTERDAY });
    await makeSale({ shopId: shopA, amount: 7_000, businessDate: DAY });

    const { rows } = await dailySales(actorFor("OWNER"), {
      shopId: shopA,
      from: iso(YESTERDAY),
      to: iso(DAY),
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ businessDate: iso(YESTERDAY), revenue: "5000" });
    expect(rows[1]).toMatchObject({ businessDate: iso(DAY), revenue: "7000" });
  });

  it("groups by shop, highest revenue first", async () => {
    await makeSale({ shopId: shopA, amount: 10_000 });
    await makeSale({ shopId: shopB, amount: 90_000 });

    const { rows } = await salesByShop(actorFor("OWNER", { shopIds: [shopA, shopB] }), {
      ...range,
    });
    const mine = rows.filter((r) => r.shopId === shopA || r.shopId === shopB);

    expect(mine[0]!.shopId).toBe(shopB);
    expect(mine[0]!.revenue).toBe("90000");
    expect(mine[1]!.revenue).toBe("10000");
  });
});

// ─────────────────────────── SCOPE + PERMISSIONS ───────────────────────────

describe("resolveScope — the manager rule (8 Aug 2026 decision)", () => {
  it("gives an OWNER every shop when no shopId is given", async () => {
    const scope = await resolveScope(actorFor("OWNER"), {});
    expect(scope.isAllShops).toBe(true);
    expect(scope.shopIds).toContain(shopA);
    expect(scope.shopIds).toContain(shopB);
  });

  /**
   * D-34's lesson: when a permission depends on whether a parameter is
   * PRESENT, both branches must be tested. One passing says nothing about the
   * other. These next two are that pair.
   */
  it("collapses an UNSCOPED manager to their work-session shop, never all shops", async () => {
    const scope = await resolveScope(
      actorFor("MANAGER", { shopIds: [shopA, shopB], workShopId: shopB }),
      {}
    );
    expect(scope.isAllShops).toBe(false);
    expect(scope.shopIds).toEqual([shopB]);
  });

  it("honours an EXPLICIT shopId a manager is assigned to", async () => {
    const scope = await resolveScope(
      actorFor("MANAGER", { shopIds: [shopA, shopB], workShopId: shopB }),
      { shopId: shopA }
    );
    expect(scope.shopIds).toEqual([shopA]);
  });

  it("refuses a shop the manager is not assigned to (R-4)", async () => {
    await expect(
      resolveScope(actorFor("MANAGER", { shopIds: [shopA] }), { shopId: shopB })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a manager with no work session and no explicit shop", async () => {
    const noSession = actorFor("MANAGER", { shopIds: [shopA], workShopId: null });
    noSession.defaultShopId = null;
    await expect(resolveScope(noSession, {})).rejects.toMatchObject({
      code: "NO_WORK_SESSION",
    });
  });

  it("rejects an inverted date range", async () => {
    await expect(
      resolveScope(actorFor("OWNER"), { from: iso(DAY), to: iso(YESTERDAY) })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("cost gating (§7.5, §15)", () => {
  it("refuses prize expense to a plain MANAGER", async () => {
    await expect(
      prizeExpenseReport(actorFor("MANAGER", { canEnterCost: false }), {
        shopId: shopA,
        ...range,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows a PURCHASING manager cost at an assigned shop", async () => {
    await consume({ shopId: shopA, qty: 2, unitCogs: 1_500, type: "REDEEM" });

    const result = await prizeExpenseReport(
      actorFor("MANAGER", { shopIds: [shopA], canEnterCost: true }),
      { shopId: shopA, ...range }
    );
    expect(result.prizeExpense).toBe("3000");
  });

  it("refuses a PURCHASING manager cost at an UNASSIGNED shop", async () => {
    await expect(
      prizeExpenseReport(actorFor("MANAGER", { shopIds: [shopA], canEnterCost: true }), {
        shopId: shopB,
        ...range,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  /**
   * The gate must be `every`, not `some`.
   *
   * A single-shop scope cannot tell those two apart — this case exists because
   * a deliberate `every`→`some` mutation passed all 33 other tests. With
   * `some`, a Purchasing manager assigned to ONE shop reads a cost figure
   * blended across shops they do not manage, which is precisely what §7.5's
   * "their assigned shops ONLY" forbids.
   *
   * `resolveScope` will not build a multi-shop scope for a manager, so the
   * gate is exercised directly against the scope a bug elsewhere could hand it.
   */
  it("refuses cost on a MIXED scope containing one unassigned shop", async () => {
    // Assigned to shopA ONLY, but handed a scope covering both. This is the
    // single case that separates `every` from `some`: with `some` the shopA
    // assignment alone would unlock a figure blended across both shops.
    const purchasing = actorFor("MANAGER", {
      shopIds: [shopA],
      canEnterCost: true,
      workShopId: shopA,
    });
    const mixedScope = {
      shopIds: [shopA, shopB],
      isAllShops: false,
      from: DAY,
      to: DAY,
    };

    expect(() => assertCanSeeCost(purchasing, mixedScope)).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" })
    );
    // …and the single-shop scope it IS entitled to still works, so the guard
    // is refusing the mix rather than refusing everything.
    expect(() =>
      assertCanSeeCost(purchasing, { ...mixedScope, shopIds: [shopA] })
    ).not.toThrow();
  });

  it("refuses PROFIT to a Purchasing manager — cost entry is not profitability", async () => {
    // CLAUDE.md is explicit: the Purchasing permission unlocks cost, and still
    // 403s on profit, margin and all-shops endpoints.
    await expect(
      profitReport(actorFor("MANAGER", { shopIds: [shopA], canEnterCost: true }), {
        shopId: shopA,
        ...range,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("gives a manager ticket QUANTITIES but no liability VALUE (§8.4)", async () => {
    const result = await liabilityReport(actorFor("MANAGER", { shopIds: [shopA] }), {
      shopId: shopA,
      ...range,
    });
    expect(result.outstandingTickets).toBeGreaterThanOrEqual(0);
    expect(result.estimatedTicketLiability).toBeNull();
    expect(result.blendedCogsPerTicket).toBeNull();
  });

  it("refuses the dashboard to STAFF entirely", async () => {
    await expect(
      getDashboard(actorFor("STAFF", { userId: staffId }), {})
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─────────────────────────── COST METRICS ───────────────────────────

describe("prize expense vs shrinkage (§9 — mixing them hides theft)", () => {
  it("counts REDEEM as prize expense and OPNAME_LOSS as shrinkage, separately", async () => {
    await consume({ shopId: shopA, qty: 3, unitCogs: 1_000, type: "REDEEM" });
    await consume({ shopId: shopA, qty: 2, unitCogs: 2_500, type: "OPNAME_LOSS" });
    await consume({ shopId: shopA, qty: 1, unitCogs: 4_000, type: "DAMAGE" });

    const result = await prizeExpenseReport(actorFor("OWNER"), {
      shopId: shopA,
      ...range,
    });

    // 3 × 1000 = 3000 prize expense; (2 × 2500) + (1 × 4000) = 9000 shrinkage.
    expect(result.prizeExpense).toBe("3000");
    expect(result.shrinkageExpense).toBe("9000");
  });

  it("uses the cost RECORDED at consumption, not the batch's current cost", async () => {
    // The whole point of unitCogsAtConsumption (CLAUDE.md): re-deriving from
    // the batch later would restate history.
    const movement = await consume({
      shopId: shopA,
      qty: 2,
      unitCogs: 1_000,
      type: "REDEEM",
    });
    const consumption = await prisma.stockConsumption.findFirstOrThrow({
      where: { movementId: movement.id },
    });
    await prisma.prizeBatch.update({
      where: { id: consumption.batchId },
      data: { unitCogs: new Prisma.Decimal(99_999) },
    });

    const result = await prizeExpenseReport(actorFor("OWNER"), {
      shopId: shopA,
      ...range,
    });
    expect(result.prizeExpense).toBe("2000");
  });

  it("scopes cost to the requested shop only", async () => {
    await consume({ shopId: shopA, qty: 1, unitCogs: 1_000, type: "REDEEM" });
    await consume({ shopId: shopB, qty: 1, unitCogs: 5_000, type: "REDEEM" });

    const result = await prizeExpenseReport(actorFor("OWNER"), {
      shopId: shopA,
      ...range,
    });
    expect(result.prizeExpense).toBe("1000");
  });
});

describe("stockValuation (§9)", () => {
  it("values live batches at qtyRemaining × unitCogs", async () => {
    await prisma.prizeBatch.create({
      data: {
        shopId: shopA,
        prizeItemId: prizeId,
        qtyReceived: 10,
        qtyRemaining: 4,
        unitCogs: new Prisma.Decimal(2_500),
        receivedAt: DAY,
      },
    });
    // A voided batch and an empty one must both be excluded.
    await prisma.prizeBatch.create({
      data: {
        shopId: shopA,
        prizeItemId: prizeId,
        qtyReceived: 10,
        qtyRemaining: 10,
        unitCogs: new Prisma.Decimal(9_999),
        receivedAt: DAY,
        isVoid: true,
      },
    });
    await prisma.prizeBatch.create({
      data: {
        shopId: shopA,
        prizeItemId: prizeId,
        qtyReceived: 10,
        qtyRemaining: 0,
        unitCogs: new Prisma.Decimal(9_999),
        receivedAt: DAY,
      },
    });

    const result = await stockValuation(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(result.total).toBe("10000");
  });
});

describe("profitReport (§9 gross and net)", () => {
  it("computes revenue − prize − shrinkage − opex, and combines correctly", async () => {
    await makeSale({ shopId: shopA, amount: 100_000 });
    await consume({ shopId: shopA, qty: 2, unitCogs: 5_000, type: "REDEEM" });
    await consume({ shopId: shopA, qty: 1, unitCogs: 3_000, type: "OPNAME_LOSS" });
    await prisma.expense.create({
      data: {
        shopId: shopA,
        categoryId,
        userId: managerId,
        amount: new Prisma.Decimal(20_000),
        businessDate: DAY,
      },
    });

    const result = await profitReport(actorFor("OWNER", { shopIds: [shopA] }), {
      shopId: shopA,
      ...range,
    });
    const row = result.rows.find((r) => r.shopId === shopA)!;

    // gross = 100000 − 10000 − 3000 = 87000; net = 87000 − 20000 = 67000
    expect(row.revenue).toBe("100000");
    expect(row.prizeExpense).toBe("10000");
    expect(row.shrinkageExpense).toBe("3000");
    expect(row.grossProfit).toBe("87000");
    expect(row.netProfit).toBe("67000");
    expect(result.combined.netProfit).toBe("67000");
  });

  it("excludes soft-deleted expenses (§9 'where not deleted')", async () => {
    await makeSale({ shopId: shopA, amount: 50_000 });
    await prisma.expense.create({
      data: {
        shopId: shopA,
        categoryId,
        userId: managerId,
        amount: new Prisma.Decimal(12_345),
        businessDate: DAY,
        isDeleted: true,
      },
    });

    const result = await profitReport(actorFor("OWNER", { shopIds: [shopA] }), {
      shopId: shopA,
      ...range,
    });
    expect(result.rows.find((r) => r.shopId === shopA)!.operatingExpenses).toBe("0");
  });
});

describe("expenseReport", () => {
  it("groups by category and totals", async () => {
    await prisma.expense.create({
      data: {
        shopId: shopA,
        categoryId,
        userId: managerId,
        amount: new Prisma.Decimal(15_000),
        businessDate: DAY,
      },
    });
    await prisma.expense.create({
      data: {
        shopId: shopA,
        categoryId,
        userId: managerId,
        amount: new Prisma.Decimal(5_000),
        businessDate: DAY,
      },
    });

    const result = await expenseReport(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(result.total).toBe("20000");
    expect(result.rows[0]!.count).toBe(2);
  });
});

// ─────────────────────────── LIABILITY ───────────────────────────

describe("liabilityReport (§9)", () => {
  it("reports tickets redeemed as a POSITIVE number from negative deltas", async () => {
    await prisma.ticketLedger.create({
      data: {
        customerId,
        shopId: shopA,
        userId: staffId,
        type: "AWARD",
        delta: 500,
        balanceAfter: 500,
        businessDate: DAY,
      },
    });
    await prisma.ticketLedger.create({
      data: {
        customerId,
        shopId: shopA,
        userId: staffId,
        type: "REDEEM",
        delta: -200,
        balanceAfter: 300,
        businessDate: DAY,
      },
    });

    const result = await liabilityReport(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(result.ticketsAwarded).toBe(500);
    expect(result.ticketsRedeemed).toBe(200);
  });

  it("values the ticket liability at blended COGS per ticket for the owner", async () => {
    // 200 tickets redeemed against 2000 of prize expense → 10 per ticket.
    await consume({ shopId: shopA, qty: 2, unitCogs: 1_000, type: "REDEEM" });
    await prisma.ticketLedger.create({
      data: {
        customerId,
        shopId: shopA,
        userId: staffId,
        type: "REDEEM",
        delta: -200,
        balanceAfter: 100,
        businessDate: DAY,
      },
    });

    const result = await liabilityReport(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(result.blendedCogsPerTicket).toBe("10");
  });

  it("returns zero rather than dividing by zero when nothing was redeemed", async () => {
    const result = await liabilityReport(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(result.blendedCogsPerTicket).toBe("0");
    expect(result.estimatedTicketLiability).toBe("0");
  });
});

// ─────────────────────────── ATTENDANCE ───────────────────────────

describe("attendanceReport (§9 late rate)", () => {
  it("computes the late rate per staff member", async () => {
    const mk = (isLate: boolean, lateMinutes: number, businessDate: Date) =>
      prisma.attendance.create({
        data: {
          userId: staffId,
          shopId: shopA,
          businessDate,
          clockInAt: businessDate,
          isLate,
          lateMinutes,
          status: isLate ? "LATE" : "PRESENT",
        },
      });
    await mk(true, 10, DAY);
    await mk(false, 0, YESTERDAY);

    const result = await attendanceReport(actorFor("OWNER"), {
      shopId: shopA,
      from: iso(YESTERDAY),
      to: iso(DAY),
    });
    const row = result.rows.find((r) => r.userId === staffId)!;

    expect(row.records).toBe(2);
    expect(row.lateCount).toBe(1);
    expect(row.lateRate).toBe("0.5");
    expect(row.averageLateMinutes).toBe("10");
  });

  it("refuses team attendance to STAFF (§3.4)", async () => {
    await expect(
      attendanceReport(actorFor("STAFF", { userId: staffId }), { shopId: shopA, ...range })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─────────────────────────── LOW STOCK ───────────────────────────

describe("lowStockReport (§4.8)", () => {
  it("flags at or below the threshold, and treats 0 as 'no alert'", async () => {
    await prisma.shopPrizeConfig.create({
      data: { shopId: shopA, prizeItemId: prizeId, lowStockThreshold: 5 },
    });
    await prisma.prizeBatch.create({
      data: {
        shopId: shopA,
        prizeItemId: prizeId,
        qtyReceived: 5,
        qtyRemaining: 5,
        unitCogs: new Prisma.Decimal(100),
        receivedAt: DAY,
      },
    });

    const flagged = await lowStockReport(actorFor("OWNER"), { shopId: shopA });
    expect(flagged.rows.find((r) => r.prizeItemId === prizeId)?.onHand).toBe(5);

    // Threshold 0 means no alert at all, even at zero stock (§4.8).
    await prisma.shopPrizeConfig.updateMany({
      where: { shopId: shopA, prizeItemId: prizeId },
      data: { lowStockThreshold: 0 },
    });
    const silent = await lowStockReport(actorFor("OWNER"), { shopId: shopA });
    expect(silent.rows.find((r) => r.prizeItemId === prizeId)).toBeUndefined();
  });
});
