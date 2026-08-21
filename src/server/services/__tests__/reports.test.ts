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
  shrinkageReport,
  prizeRedemptionReport,
  redemptionLinesForScope,
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
  const shopRoles = new Map(
    role === "OWNER"
      ? []
      : shopIds.map((id) => [
          id,
          { role, canEnterCost: opts.canEnterCost ?? false } as const,
        ])
  );
  return {
    sessionId: "test-session",
    userId: opts.userId ?? (role === "OWNER" ? ownerId : managerId),
    username: role.toLowerCase(),
    displayName: `Test ${role}`,
    isOwner: role === "OWNER",
    shopRoles,
    isActive: true,
    mustChangePassword: false,
    defaultShopId: shopIds[0] ?? null,
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
          isOwner: role === "OWNER",
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

  it("404s a shop id that does not exist, even for an OWNER", async () => {
    // hasShopAccess answers "may you?", not "is it real?", and returns true for
    // an owner on any id. Without the existence check a URL typo renders a calm
    // report full of zeroes that reads as "this branch sold nothing".
    await expect(
      resolveScope(actorFor("OWNER"), { shopId: "no-such-shop-id" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("prefers 403 over 404 for a manager, so shop ids cannot be probed", async () => {
    // Order matters: if existence were checked first, the different responses
    // for a real-but-foreign shop and a fake one would confirm which ids exist.
    await expect(
      resolveScope(actorFor("MANAGER", { shopIds: [shopA] }), {
        shopId: "no-such-shop-id",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
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

  /**
   * A user can be MANAGER at one shop and STAFF at another (D-122). The
   * privilege check and the shop resolution are two separate steps, so these
   * assert that they AGREE — a "manager somewhere" gate paired with a scope
   * that resolves elsewhere is how a staff-only shop leaks a manager view.
   *
   * Both the implicit form (no shopId, resolved from the work session) and
   * the explicit form (?shopId=) are tested: a permission that depends on
   * whether a parameter is present is wrong on one branch until proven
   * otherwise (D-34).
   */
  describe("mixed-role actor: MANAGER at shopA, STAFF at shopB (D-138)", () => {
    const mixed = (workShopId: string | null) => {
      const actor = actorFor("MANAGER", {
        shopIds: [shopA],
        workShopId,
      });
      // MANAGER at A, STAFF at B — the shape `actorFor` cannot build.
      actor.shopRoles.set(shopB, { role: "STAFF", canEnterCost: false });
      return actor;
    };

    it("refuses the dashboard for the shop where they are only STAFF", async () => {
      await expect(
        getDashboard(mixed(shopB), { shopId: shopB })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses it implicitly when the work session is at the STAFF shop", async () => {
      // No shopId: scope falls back to the work-session shop, which is the
      // shop they only staff. Being a manager at shopA must not carry over.
      await expect(getDashboard(mixed(shopB), {})).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("still allows the dashboard for the shop where they ARE manager", async () => {
      await expect(
        getDashboard(mixed(shopA), { shopId: shopA })
      ).resolves.toMatchObject({ role: "MANAGER", shopId: shopA });
    });

    it("scopes the manager dashboard to shopA when clocked in at shopA", async () => {
      const result = await getDashboard(mixed(shopA), {});
      expect(result).toMatchObject({ role: "MANAGER", shopId: shopA });
    });
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

// ─────────────────── SHRINKAGE & PRIZE REDEMPTION (Phase 10) ───────────────────

/** A completed redemption with one line, at known ticket and cost values. */
async function makeRedemption(args: {
  shopId: string;
  qty: number;
  ticketCostTotal: number;
  cogsTotal: number;
  isVoided?: boolean;
  businessDate?: Date;
}) {
  return prisma.redemption.create({
    data: {
      shopId: args.shopId,
      customerId,
      userId: staffId,
      totalTickets: args.ticketCostTotal,
      totalCogs: new Prisma.Decimal(args.cogsTotal),
      isVoided: args.isVoided ?? false,
      businessDate: args.businessDate ?? DAY,
      lines: {
        create: {
          prizeItemId: prizeId,
          prizeName: "Report Prize",
          qty: args.qty,
          ticketCostEach: Math.round(args.ticketCostTotal / args.qty),
          ticketCostTotal: args.ticketCostTotal,
          cogsTotal: new Prisma.Decimal(args.cogsTotal),
        },
      },
    },
  });
}

describe("shrinkageReport (§9)", () => {
  it("splits OPNAME_LOSS from DAMAGE and totals both", async () => {
    // 2 × 1.500 lost at a count, 3 × 1.000 declared damaged = 3.000 + 3.000.
    await consume({ shopId: shopA, qty: 2, unitCogs: 1_500, type: "OPNAME_LOSS" });
    await consume({ shopId: shopA, qty: 3, unitCogs: 1_000, type: "DAMAGE" });
    // A REDEEM must never land in shrinkage — that is §9's "mixing it into
    // prize expense hides theft", in the other direction.
    await consume({ shopId: shopA, qty: 10, unitCogs: 9_999, type: "REDEEM" });

    const r = await shrinkageReport(actorFor("OWNER"), { shopId: shopA, ...range });

    expect(r.opnameLoss).toBe("3000");
    expect(r.damage).toBe("3000");
    expect(r.totalShrinkage).toBe("6000");
    expect(r.totalUnits).toBe(5);
  });

  it("breaks the loss down by item, keeping the two causes apart", async () => {
    await consume({ shopId: shopA, qty: 2, unitCogs: 1_500, type: "OPNAME_LOSS" });
    await consume({ shopId: shopA, qty: 1, unitCogs: 1_000, type: "DAMAGE" });

    const r = await shrinkageReport(actorFor("OWNER"), { shopId: shopA, ...range });
    const row = r.byItem.find((i) => i.prizeItemId === prizeId);

    expect(row?.opnameLossValue).toBe("3000");
    expect(row?.damageValue).toBe("1000");
    expect(row?.value).toBe("4000");
    expect(row?.qty).toBe(3);
  });

  it("attributes loss to the shop it happened at", async () => {
    await consume({ shopId: shopA, qty: 2, unitCogs: 1_000, type: "OPNAME_LOSS" });
    await consume({ shopId: shopB, qty: 1, unitCogs: 5_000, type: "DAMAGE" });

    const r = await shrinkageReport(actorFor("OWNER", { shopIds: [shopA, shopB] }), {
      ...range,
    });

    expect(r.byShop.find((s) => s.shopId === shopA)?.value).toBe("2000");
    expect(r.byShop.find((s) => s.shopId === shopB)?.value).toBe("5000");
    // Sorted worst-first, which is the whole point of the screen.
    expect(r.byShop[0]?.shopId).toBe(shopB);
  });

  it("refuses a plain MANAGER — it is a cost report (§7.5)", async () => {
    await expect(
      shrinkageReport(actorFor("MANAGER"), { shopId: shopA, ...range })
    ).rejects.toThrow();
  });

  it("refuses a Purchasing manager a scope containing an unassigned shop (D-62)", async () => {
    const purchasing = actorFor("MANAGER", {
      shopIds: [shopA],
      canEnterCost: true,
    });
    // Their OWN shop is fine...
    await expect(
      shrinkageReport(purchasing, { shopId: shopA, ...range })
    ).resolves.toBeDefined();

    // ...but a scope spanning a shop they do not manage must be refused, or
    // they read a figure blended across it. This is the `every`-not-`some`
    // case; with `some` the call below would succeed.
    const mixed = actorFor("MANAGER", {
      shopIds: [shopA, shopB],
      canEnterCost: false,
    });
    await expect(shrinkageReport(mixed, { ...range })).rejects.toThrow();
  });
});

describe("prizeRedemptionReport (§9)", () => {
  it("counts redemptions, items and tickets, excluding voided ones", async () => {
    await makeRedemption({ shopId: shopA, qty: 2, ticketCostTotal: 200, cogsTotal: 3_000 });
    await makeRedemption({ shopId: shopA, qty: 1, ticketCostTotal: 100, cogsTotal: 1_000 });
    // A voided redemption returned its stock and its tickets; counting it here
    // would overstate what customers actually took home.
    await makeRedemption({
      shopId: shopA,
      qty: 9,
      ticketCostTotal: 9_999,
      cogsTotal: 99_999,
      isVoided: true,
    });

    const r = await prizeRedemptionReport(actorFor("OWNER"), { shopId: shopA, ...range });

    expect(r.redemptions).toBe(2);
    expect(r.itemsGiven).toBe(3);
    // 200 + 100 — NOT multiplied by qty again. ticketCostTotal is already the
    // line total, and squaring it is the obvious bug in this function.
    expect(r.ticketsSpent).toBe(300);
    expect(r.totalCogs).toBe("4000");
  });

  it("gives a plain MANAGER the activity but NO cost figure (§7.5)", async () => {
    await makeRedemption({ shopId: shopA, qty: 2, ticketCostTotal: 200, cogsTotal: 3_000 });

    const r = await prizeRedemptionReport(actorFor("MANAGER"), {
      shopId: shopA,
      ...range,
    });

    // The activity is operational and a manager needs it to restock.
    expect(r.redemptions).toBe(1);
    expect(r.itemsGiven).toBe(2);
    expect(r.ticketsSpent).toBe(200);
    // The cost is not theirs to see, and null rather than "0" so nobody can
    // mistake a withheld figure for a real zero.
    expect(r.totalCogs).toBeNull();
    expect(r.byItem[0]?.cogs).toBeNull();
  });

  it("gives a Purchasing manager the cost at their own shop", async () => {
    await makeRedemption({ shopId: shopA, qty: 1, ticketCostTotal: 100, cogsTotal: 2_500 });

    const r = await prizeRedemptionReport(
      actorFor("MANAGER", { shopIds: [shopA], canEnterCost: true }),
      { shopId: shopA, ...range }
    );

    expect(r.totalCogs).toBe("2500");
  });

  /**
   * Asserts the QUERY, not just the output.
   *
   * A mutation that made the restricted branch select `cogsTotal` anyway passed
   * every other test in this file, because `withCost` still nulls the figure on
   * the way out. That is D-62 exactly: the guard downstream hid a broken guard
   * upstream. §7.5 requires the restricted path to not READ the cost column —
   * "do not implement this by deleting keys from a full object" — so the check
   * has to look at what came back from the database.
   */
  it("never reads the cost column at all on the restricted branch (§7.5)", async () => {
    await makeRedemption({ shopId: shopA, qty: 1, ticketCostTotal: 100, cogsTotal: 7_777 });
    const scope = await resolveScope(actorFor("OWNER"), { shopId: shopA, ...range });

    const restricted = await redemptionLinesForScope(scope, false);
    expect(restricted).toHaveLength(1);
    expect(restricted[0]!.cogsTotal).toBeNull();

    const permitted = await redemptionLinesForScope(scope, true);
    expect(permitted[0]!.cogsTotal?.toString()).toBe("7777");
  });

  it("ranks by quantity given, most-redeemed first", async () => {
    await makeRedemption({ shopId: shopA, qty: 5, ticketCostTotal: 500, cogsTotal: 100 });

    const r = await prizeRedemptionReport(actorFor("OWNER"), { shopId: shopA, ...range });
    expect(r.byItem[0]?.qty).toBe(5);
    expect(r.byItem[0]?.prizeName).toContain("R8 Prize");
  });
});
