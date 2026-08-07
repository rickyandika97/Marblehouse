/**
 * FIFO under real transaction boundaries and real concurrency (PRD §15,
 * "Integration tests").
 *
 * These deliberately do NOT use `withRollback`: the behaviour under test IS the
 * commit/rollback boundary, and two racing transactions cannot share one. They
 * therefore write to the development database and clean up after themselves.
 */
import { describe, expect, test, afterAll, afterEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, makeShop, makePrize, makeBatch, BUSINESS_DATE } from "./helpers";
import { consumeFifo, onHand, InsufficientStockError } from "../inventory";

const createdShopIds: string[] = [];
const createdPrizeIds: string[] = [];

async function fixture(batches: Array<{ qty: number; unitCogs: number }>) {
  const shop = await makeShop(prisma);
  const prize = await makePrize(prisma);
  createdShopIds.push(shop.id);
  createdPrizeIds.push(prize.id);
  for (const [i, b] of batches.entries()) {
    await makeBatch(prisma, {
      shopId: shop.id,
      prizeItemId: prize.id,
      qty: b.qty,
      unitCogs: b.unitCogs,
      dayOffset: i,
    });
  }
  return { shopId: shop.id, prizeItemId: prize.id };
}

afterEach(async () => {
  // Order matters: consumptions reference movements and batches.
  await prisma.stockConsumption.deleteMany({
    where: { batch: { shopId: { in: createdShopIds } } },
  });
  await prisma.stockMovement.deleteMany({
    where: { shopId: { in: createdShopIds } },
  });
  await prisma.prizeBatch.deleteMany({
    where: { shopId: { in: createdShopIds } },
  });
  await prisma.prizeItem.deleteMany({ where: { id: { in: createdPrizeIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: createdShopIds } } });
  createdShopIds.length = 0;
  createdPrizeIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const args = (shopId: string, prizeItemId: string, qty: number) => ({
  shopId,
  prizeItemId,
  qty,
  type: "REDEEM" as const,
  businessDate: BUSINESS_DATE,
  userId: null,
});

describe("transaction boundary", () => {
  test("§15.5 — an over-consume leaves NOTHING committed, across the real boundary", async () => {
    const { shopId, prizeItemId } = await fixture([
      { qty: 3, unitCogs: 1000 },
      { qty: 2, unitCogs: 5000 },
    ]);

    // The in-transaction assertion in inventory.test.ts cannot prove this,
    // because the throw rolls back the very transaction doing the asserting.
    // Here the rejection escapes a committed boundary and we re-read fresh.
    await expect(
      prisma.$transaction((tx) => consumeFifo(tx, args(shopId, prizeItemId, 6)))
    ).rejects.toThrow(InsufficientStockError);

    expect(await onHand(prisma, shopId, prizeItemId)).toBe(5);
    expect(await prisma.stockMovement.count({ where: { shopId } })).toBe(0);
    expect(
      await prisma.stockConsumption.count({ where: { batch: { shopId } } })
    ).toBe(0);
  });

  test("a partially-completed consume rolls back the batches it already touched", async () => {
    // 4 units on hand across two batches; ask for 5. The engine decrements the
    // first batch before discovering the shortfall on the second pass, so this
    // is the case where a missing rollback would silently destroy stock.
    const { shopId, prizeItemId } = await fixture([
      { qty: 3, unitCogs: 1000 },
      { qty: 1, unitCogs: 2000 },
    ]);

    await expect(
      prisma.$transaction((tx) => consumeFifo(tx, args(shopId, prizeItemId, 5)))
    ).rejects.toThrow(InsufficientStockError);

    const batches = await prisma.prizeBatch.findMany({
      where: { shopId, prizeItemId },
      orderBy: { receivedAt: "asc" },
      select: { qtyRemaining: true },
    });
    expect(batches.map((b) => b.qtyRemaining)).toEqual([3, 1]);
  });
});

describe("concurrent consumption", () => {
  test("two redemptions for the last unit — exactly one succeeds", async () => {
    const { shopId, prizeItemId } = await fixture([{ qty: 1, unitCogs: 1000 }]);

    const attempt = () =>
      prisma
        .$transaction((tx) => consumeFifo(tx, args(shopId, prizeItemId, 1)))
        .then(
          () => "ok" as const,
          () => "rejected" as const
        );

    const results = await Promise.all([attempt(), attempt()]);

    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "rejected")).toHaveLength(1);
    expect(await onHand(prisma, shopId, prizeItemId)).toBe(0);
  });

  test("parallel consumption never oversells and never loses a unit", async () => {
    // 20 on hand, ten concurrent requests for 3 each = demand for 30. Whatever
    // the interleaving, consumed + remaining must equal exactly 20.
    const { shopId, prizeItemId } = await fixture([
      { qty: 8, unitCogs: 1000 },
      { qty: 12, unitCogs: 2000 },
    ]);

    const attempts = Array.from({ length: 10 }, () =>
      prisma
        .$transaction((tx) => consumeFifo(tx, args(shopId, prizeItemId, 3)))
        .then(
          () => 3,
          () => 0
        )
    );
    const consumed = (await Promise.all(attempts)).reduce((a, b) => a + b, 0);

    const left = await onHand(prisma, shopId, prizeItemId);
    expect(consumed + left).toBe(20);
    expect(left).toBeGreaterThanOrEqual(0);

    // And the ledger must agree with the batches — the §4.8 invariant.
    const rows = await prisma.stockConsumption.findMany({
      where: { batch: { shopId } },
      select: { qty: true },
    });
    expect(rows.reduce((sum, r) => sum + r.qty, 0)).toBe(consumed);
  });
});
