/**
 * Redemption checkout (PRD §4.9, §15 "Integration tests").
 *
 * §16 accepts Phase 4 partly on "concurrent redemptions behave correctly". The
 * FIFO engine is already proven under concurrency; what these prove is the
 * TRANSACTION AROUND IT — that tickets, stock and the redemption row move
 * together or not at all.
 *
 * Like the concurrency suite these write real rows and clean up afterwards,
 * because two racing transactions cannot share a rollback.
 */
import { describe, expect, test, afterAll, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, makeShop, makePrize, makeBatch, uniq } from "./helpers";
import { createRedemption, voidRedemption } from "../redemptions";
import type { Actor } from "@/server/auth/context";

const shopIds: string[] = [];
const prizeIds: string[] = [];
const customerIds: string[] = [];

async function fixture(opts: {
  ticketBalance: number;
  ticketCost?: number;
  batches: Array<{ qty: number; unitCogs: number }>;
}) {
  const shop = await makeShop(prisma);
  const prize = await makePrize(prisma, opts.ticketCost ?? 100);
  shopIds.push(shop.id);
  prizeIds.push(prize.id);

  for (const [i, b] of opts.batches.entries()) {
    await makeBatch(prisma, {
      shopId: shop.id,
      prizeItemId: prize.id,
      qty: b.qty,
      unitCogs: b.unitCogs,
      dayOffset: i,
    });
  }

  await prisma.shopPrizeConfig.create({
    data: { shopId: shop.id, prizeItemId: prize.id, isActive: true },
  });

  const suffix = uniq();
  const customer = await prisma.customer.create({
    data: {
      name: `Redeem Test ${suffix}`,
      phoneRaw: `0899${suffix}`,
      phoneNormalized: `+62899${suffix}`,
      ticketBalance: opts.ticketBalance,
    },
  });
  customerIds.push(customer.id);

  const user = await prisma.user.findFirstOrThrow();
  const workSession = await prisma.workSession.findFirst({
    where: { userId: user.id },
    include: { shop: true },
  });

  const actor = {
    sessionId: "test",
    userId: user.id,
    username: user.username ?? "test",
    displayName: user.displayName,
    role: "STAFF",
    isActive: true,
    mustChangePassword: false,
    canEnterCost: false,
    defaultShopId: null,
    assignedShopIds: [shop.id],
    businessDate: new Date("2026-01-15T00:00:00.000Z"),
    workSession: {
      ...(workSession ?? {
        id: "ws_test",
        userId: user.id,
        businessDate: new Date("2026-01-15T00:00:00.000Z"),
        shopId: shop.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
      shopId: shop.id,
      shop,
    },
  } as unknown as Actor & { workSession: NonNullable<Actor["workSession"]> };

  return { shopId: shop.id, prizeItemId: prize.id, customerId: customer.id, actor };
}

afterEach(async () => {
  await prisma.redemptionLine.deleteMany({
    where: { redemption: { shopId: { in: shopIds } } },
  });
  await prisma.redemption.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.ticketLedger.deleteMany({
    where: { customerId: { in: customerIds } },
  });
  await prisma.stockConsumption.deleteMany({
    where: { batch: { shopId: { in: shopIds } } },
  });
  await prisma.stockMovement.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.prizeBatch.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.shopPrizeConfig.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.auditLog.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.prizeItem.deleteMany({ where: { id: { in: prizeIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  shopIds.length = 0;
  prizeIds.length = 0;
  customerIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("redemption checkout", () => {
  test("spends tickets, consumes FIFO and records true cost", async () => {
    const f = await fixture({
      ticketBalance: 1000,
      ticketCost: 100,
      batches: [
        { qty: 2, unitCogs: 1000 },
        { qty: 5, unitCogs: 3000 },
      ],
    });

    const result = await prisma.$transaction((tx) =>
      createRedemption(f.actor, {
        customerId: f.customerId,
        lines: [{ prizeItemId: f.prizeItemId, qty: 4 }],
      }, tx)
    );

    expect(result.totalTickets).toBe(400);
    expect(result.ticketBalanceAfter).toBe(600);

    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: f.customerId },
    });
    expect(customer.ticketBalance).toBe(600);

    // 2 units at 1000 then 2 at 3000 — FIFO, not an average of 2000.
    const redemption = await prisma.redemption.findUniqueOrThrow({
      where: { id: result.id },
    });
    expect(redemption.totalCogs.toString()).toBe("8000");

    const batches = await prisma.prizeBatch.findMany({
      where: { shopId: f.shopId },
      orderBy: { receivedAt: "asc" },
    });
    expect(batches.map((b) => b.qtyRemaining)).toEqual([0, 3]);
  });

  test("insufficient tickets writes nothing at all", async () => {
    const f = await fixture({
      ticketBalance: 100,
      ticketCost: 100,
      batches: [{ qty: 10, unitCogs: 1000 }],
    });

    await expect(
      prisma.$transaction((tx) =>
        createRedemption(f.actor, {
          customerId: f.customerId,
          lines: [{ prizeItemId: f.prizeItemId, qty: 5 }],
        }, tx)
      )
    ).rejects.toThrow(/tickets/i);

    expect(await prisma.redemption.count({ where: { shopId: f.shopId } })).toBe(0);
    expect(await prisma.stockMovement.count({ where: { shopId: f.shopId } })).toBe(0);
    const batch = await prisma.prizeBatch.findFirstOrThrow({
      where: { shopId: f.shopId },
    });
    expect(batch.qtyRemaining).toBe(10);
  });

  test("insufficient stock writes nothing at all — including the tickets", async () => {
    const f = await fixture({
      ticketBalance: 100_000,
      ticketCost: 100,
      batches: [{ qty: 3, unitCogs: 1000 }],
    });

    await expect(
      prisma.$transaction((tx) =>
        createRedemption(f.actor, {
          customerId: f.customerId,
          lines: [{ prizeItemId: f.prizeItemId, qty: 5 }],
        }, tx)
      )
    ).rejects.toThrow(/stock/i);

    // The important half: the customer must NOT have been charged for a
    // redemption that could not be filled.
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: f.customerId },
    });
    expect(customer.ticketBalance).toBe(100_000);
    expect(await prisma.redemption.count({ where: { shopId: f.shopId } })).toBe(0);
    expect(await prisma.ticketLedger.count({ where: { customerId: f.customerId } })).toBe(0);
  });

  test("duplicate lines for one prize are merged, not checked separately", async () => {
    const f = await fixture({
      ticketBalance: 100_000,
      ticketCost: 100,
      batches: [{ qty: 3, unitCogs: 1000 }],
    });

    // 2 + 2 = 4 against 3 on hand. Checked line-by-line both would pass.
    await expect(
      prisma.$transaction((tx) =>
        createRedemption(f.actor, {
          customerId: f.customerId,
          lines: [
            { prizeItemId: f.prizeItemId, qty: 2 },
            { prizeItemId: f.prizeItemId, qty: 2 },
          ],
        }, tx)
      )
    ).rejects.toThrow(/stock/i);

    const batch = await prisma.prizeBatch.findFirstOrThrow({
      where: { shopId: f.shopId },
    });
    expect(batch.qtyRemaining).toBe(3);
  });

  test("a prize not stocked at this shop cannot be redeemed by direct call", async () => {
    const f = await fixture({
      ticketBalance: 100_000,
      ticketCost: 100,
      batches: [{ qty: 5, unitCogs: 1000 }],
    });

    await prisma.shopPrizeConfig.updateMany({
      where: { shopId: f.shopId, prizeItemId: f.prizeItemId },
      data: { isActive: false },
    });

    await expect(
      prisma.$transaction((tx) =>
        createRedemption(f.actor, {
          customerId: f.customerId,
          lines: [{ prizeItemId: f.prizeItemId, qty: 1 }],
        }, tx)
      )
    ).rejects.toThrow(/not stocked/i);
  });

  test("ticket cost comes from the server, not the request", async () => {
    const f = await fixture({
      ticketBalance: 1000,
      ticketCost: 250,
      batches: [{ qty: 5, unitCogs: 1000 }],
    });

    // The schema has no ticketCost field at all, so a client cannot express a
    // price. This asserts the server's price is what was charged.
    const result = await prisma.$transaction((tx) =>
      createRedemption(f.actor, {
        customerId: f.customerId,
        lines: [{ prizeItemId: f.prizeItemId, qty: 2 }],
      }, tx)
    );

    expect(result.totalTickets).toBe(500);
    expect(result.lines[0]?.ticketCostEach).toBe(250);
  });
});

describe("concurrent redemptions", () => {
  test("two redemptions, tickets for only one — exactly one succeeds", async () => {
    const f = await fixture({
      ticketBalance: 100,
      ticketCost: 100,
      batches: [{ qty: 10, unitCogs: 1000 }],
    });

    const attempt = () =>
      prisma
        .$transaction((tx) =>
          createRedemption(f.actor, {
            customerId: f.customerId,
            lines: [{ prizeItemId: f.prizeItemId, qty: 1 }],
          }, tx)
        )
        .then(() => "ok" as const, () => "rejected" as const);

    const results = await Promise.all([attempt(), attempt()]);

    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: f.customerId },
    });
    expect(customer.ticketBalance).toBe(0);
    expect(await prisma.redemption.count({ where: { shopId: f.shopId } })).toBe(1);
  });

  test("two redemptions for the last unit — exactly one succeeds", async () => {
    const f = await fixture({
      ticketBalance: 100_000,
      ticketCost: 100,
      batches: [{ qty: 1, unitCogs: 1000 }],
    });

    const attempt = () =>
      prisma
        .$transaction((tx) =>
          createRedemption(f.actor, {
            customerId: f.customerId,
            lines: [{ prizeItemId: f.prizeItemId, qty: 1 }],
          }, tx)
        )
        .then(() => "ok" as const, () => "rejected" as const);

    const results = await Promise.all([attempt(), attempt()]);

    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    const batch = await prisma.prizeBatch.findFirstOrThrow({
      where: { shopId: f.shopId },
    });
    expect(batch.qtyRemaining).toBe(0);
  });
});

describe("redemption void", () => {
  test("restores tickets and the exact batches", async () => {
    const f = await fixture({
      ticketBalance: 1000,
      ticketCost: 100,
      batches: [
        { qty: 2, unitCogs: 1000 },
        { qty: 5, unitCogs: 3000 },
      ],
    });

    const created = await prisma.$transaction((tx) =>
      createRedemption(f.actor, {
        customerId: f.customerId,
        lines: [{ prizeItemId: f.prizeItemId, qty: 4 }],
      }, tx)
    );

    const owner = { ...f.actor, role: "OWNER" } as typeof f.actor;
    await prisma.$transaction((tx) =>
      voidRedemption(owner, created.id, { reason: "wrong prize handed over" }, tx)
    );

    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: f.customerId },
    });
    expect(customer.ticketBalance).toBe(1000);

    const batches = await prisma.prizeBatch.findMany({
      where: { shopId: f.shopId },
      orderBy: { receivedAt: "asc" },
    });
    expect(batches.map((b) => b.qtyRemaining)).toEqual([2, 5]);

    const voided = await prisma.redemption.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(voided.isVoided).toBe(true);
    expect(voided.voidReason).toBe("wrong prize handed over");
  });

  test("a plain staff member cannot void", async () => {
    const f = await fixture({
      ticketBalance: 1000,
      ticketCost: 100,
      batches: [{ qty: 5, unitCogs: 1000 }],
    });

    const created = await prisma.$transaction((tx) =>
      createRedemption(f.actor, {
        customerId: f.customerId,
        lines: [{ prizeItemId: f.prizeItemId, qty: 1 }],
      }, tx)
    );

    await expect(
      prisma.$transaction((tx) =>
        voidRedemption(f.actor, created.id, { reason: "nope" }, tx)
      )
    ).rejects.toThrow(/owner/i);
  });

  test("voiding twice is refused and does not double-restore", async () => {
    const f = await fixture({
      ticketBalance: 1000,
      ticketCost: 100,
      batches: [{ qty: 5, unitCogs: 1000 }],
    });

    const created = await prisma.$transaction((tx) =>
      createRedemption(f.actor, {
        customerId: f.customerId,
        lines: [{ prizeItemId: f.prizeItemId, qty: 2 }],
      }, tx)
    );

    const owner = { ...f.actor, role: "OWNER" } as typeof f.actor;
    await prisma.$transaction((tx) =>
      voidRedemption(owner, created.id, { reason: "first" }, tx)
    );
    await expect(
      prisma.$transaction((tx) =>
        voidRedemption(owner, created.id, { reason: "second" }, tx)
      )
    ).rejects.toThrow(/already been voided/i);

    const batch = await prisma.prizeBatch.findFirstOrThrow({
      where: { shopId: f.shopId },
    });
    expect(batch.qtyRemaining).toBe(5);
    const customer = await prisma.customer.findUniqueOrThrow({
      where: { id: f.customerId },
    });
    expect(customer.ticketBalance).toBe(1000);
  });
});
