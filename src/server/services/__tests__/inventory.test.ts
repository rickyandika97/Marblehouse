/**
 * FIFO engine — PRD §15 tests 1 to 10.
 *
 * These were written before `inventory.ts` existed (§17's Phase 4 opener) and
 * are the acceptance proof for the hardest invariant in the product: prize
 * expense is the sum of what each unit ACTUALLY cost, never a recomputed
 * average.
 *
 * §15 numbering is preserved in the test names so a failure maps straight back
 * to the spec.
 */
import { describe, expect, test, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import {
  prisma,
  withRollback,
  makeShop,
  makePrize,
  makeBatch,
  remaining,
  BUSINESS_DATE,
} from "./helpers";
import {
  consumeFifo,
  onHand,
  restoreConsumption,
  weightedAverageCost,
  backfillBatchCost,
  InsufficientStockError,
} from "../inventory";

afterAll(async () => {
  await prisma.$disconnect();
});

/** Shop + prize + the given batches, in one go. */
async function scenario(
  tx: Prisma.TransactionClient,
  batches: Array<{ qty: number; unitCogs: number; dayOffset?: number }>
) {
  const shop = await makeShop(tx);
  const prize = await makePrize(tx);
  for (const [i, b] of batches.entries()) {
    await makeBatch(tx, {
      shopId: shop.id,
      prizeItemId: prize.id,
      qty: b.qty,
      unitCogs: b.unitCogs,
      dayOffset: b.dayOffset ?? i,
    });
  }
  return { shopId: shop.id, prizeItemId: prize.id };
}

const consumeArgs = (shopId: string, prizeItemId: string, qty: number) => ({
  shopId,
  prizeItemId,
  qty,
  type: "REDEEM" as const,
  businessDate: BUSINESS_DATE,
  userId: null,
});

describe("FIFO consumption", () => {
  test("§15.1 — consumes within a single batch", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 10, unitCogs: 1000 },
        { qty: 10, unitCogs: 2000 },
      ]);

      const result = await consumeFifo(tx, consumeArgs(shopId, prizeItemId, 4));

      expect(result.consumptions.map((c) => c.qty)).toEqual([4]);
      expect(result.totalCogs.toString()).toBe("4000");
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([6, 10]);
    });
  });

  test("§15.2 — consumes spanning exactly two batches", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 10, unitCogs: 1000 },
        { qty: 10, unitCogs: 2000 },
      ]);

      // 10 from the first batch, 5 from the second: no remainder in batch one.
      const result = await consumeFifo(tx, consumeArgs(shopId, prizeItemId, 15));

      expect(result.consumptions.map((c) => c.qty)).toEqual([10, 5]);
      expect(result.totalCogs.toString()).toBe("20000"); // 10*1000 + 5*2000
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([0, 5]);
    });
  });

  test("§15.3 — consumes spanning three batches with a remainder", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 5, unitCogs: 1000 },
        { qty: 5, unitCogs: 2000 },
        { qty: 10, unitCogs: 3000 },
      ]);

      const result = await consumeFifo(tx, consumeArgs(shopId, prizeItemId, 13));

      expect(result.consumptions.map((c) => c.qty)).toEqual([5, 5, 3]);
      // 5*1000 + 5*2000 + 3*3000
      expect(result.totalCogs.toString()).toBe("24000");
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([0, 0, 7]);
    });
  });

  test("§15.4 — consumes exactly the last unit of the last batch", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 3, unitCogs: 1000 },
        { qty: 2, unitCogs: 5000 },
      ]);

      const result = await consumeFifo(tx, consumeArgs(shopId, prizeItemId, 5));

      expect(result.consumptions.map((c) => c.qty)).toEqual([3, 2]);
      expect(result.totalCogs.toString()).toBe("13000");
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([0, 0]);
      expect(await onHand(tx, shopId, prizeItemId)).toBe(0);
    });
  });

  test("§15.5 — consuming more than on-hand is rejected with no partial writes", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 3, unitCogs: 1000 },
        { qty: 2, unitCogs: 5000 },
      ]);

      await expect(
        consumeFifo(tx, consumeArgs(shopId, prizeItemId, 6))
      ).rejects.toThrow(InsufficientStockError);

      // The critical half of this test: the rejection must leave NOTHING behind.
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([3, 2]);
      expect(await tx.stockMovement.count({ where: { shopId } })).toBe(0);
      expect(
        await tx.stockConsumption.count({ where: { batch: { shopId } } })
      ).toBe(0);
    });
  });

  test("§15.6 — honours receivedAt order, including a transferred older batch", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);

      // Created first, but received LATER — a locally-newer batch.
      await makeBatch(tx, {
        shopId: shop.id,
        prizeItemId: prize.id,
        qty: 5,
        unitCogs: 9000,
        dayOffset: 30,
      });
      // Created second, but carries a preserved older receivedAt, as a batch
      // transferred in from another branch does (§4.10). FIFO must take it
      // FIRST despite it being the newer row.
      await makeBatch(tx, {
        shopId: shop.id,
        prizeItemId: prize.id,
        qty: 4,
        unitCogs: 1000,
        dayOffset: 1,
      });

      const result = await consumeFifo(tx, consumeArgs(shop.id, prize.id, 6));

      // 4 from the cheap transferred batch, then 2 from the newer local one.
      expect(result.consumptions.map((c) => c.qty)).toEqual([4, 2]);
      expect(result.totalCogs.toString()).toBe("22000"); // 4*1000 + 2*9000
      expect(await remaining(tx, shop.id, prize.id)).toEqual([0, 3]);
    });
  });

  test("skips void batches entirely", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      await makeBatch(tx, {
        shopId: shop.id,
        prizeItemId: prize.id,
        qty: 10,
        unitCogs: 1000,
        dayOffset: 0,
        isVoid: true,
      });
      await makeBatch(tx, {
        shopId: shop.id,
        prizeItemId: prize.id,
        qty: 5,
        unitCogs: 2000,
        dayOffset: 1,
      });

      expect(await onHand(tx, shop.id, prize.id)).toBe(5);

      const result = await consumeFifo(tx, consumeArgs(shop.id, prize.id, 5));
      expect(result.consumptions.map((c) => c.qty)).toEqual([5]);
      expect(result.totalCogs.toString()).toBe("10000");
    });
  });

  test("records unitCogs as at the moment of consumption", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 5, unitCogs: 1234.56 },
      ]);

      const result = await consumeFifo(tx, consumeArgs(shopId, prizeItemId, 2));
      const rows = await tx.stockConsumption.findMany({
        where: { movementId: result.movement.id },
      });

      expect(rows.map((r) => r.unitCogsAtConsumption.toString())).toEqual([
        "1234.56",
      ]);
      // Decimal arithmetic, not float: 2 * 1234.56 is exactly 2469.12.
      expect(result.totalCogs.toString()).toBe("2469.12");
    });
  });
});

describe("uncosted batches and backfill", () => {
  test("§15.7 — backfilling an uncosted batch updates consumptions and redemption totals", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const batch = await makeBatch(tx, {
        shopId: shop.id,
        prizeItemId: prize.id,
        qty: 10,
        unitCogs: 0,
        needsCosting: true,
      });

      // A manager without Purchasing received this stock, so FIFO consumes it
      // at zero (§7.5) — prize expense is understated until the owner prices it.
      const result = await consumeFifo(tx, consumeArgs(shop.id, prize.id, 4));
      expect(result.totalCogs.toString()).toBe("0");

      const customer = await tx.customer.create({
        data: {
          name: "Backfill Test",
          phoneRaw: `08${Date.now()}`.slice(0, 13),
          phoneNormalized: `+628${Date.now()}`.slice(0, 14),
        },
      });
      const user = await tx.user.findFirstOrThrow();
      const redemption = await tx.redemption.create({
        data: {
          shopId: shop.id,
          customerId: customer.id,
          userId: user.id,
          totalTickets: 400,
          totalCogs: new Prisma.Decimal(0),
          businessDate: BUSINESS_DATE,
          lines: {
            create: [
              {
                prizeItemId: prize.id,
                prizeName: prize.name,
                qty: 4,
                ticketCostEach: 100,
                ticketCostTotal: 400,
                cogsTotal: new Prisma.Decimal(0),
                movementId: result.movement.id,
              },
            ],
          },
        },
      });

      const summary = await backfillBatchCost(tx, {
        batchId: batch.id,
        unitCogs: new Prisma.Decimal(2500),
      });

      expect(summary.consumptionsUpdated).toBe(1);

      const consumption = await tx.stockConsumption.findFirstOrThrow({
        where: { batchId: batch.id },
      });
      expect(consumption.unitCogsAtConsumption.toString()).toBe("2500");

      const line = await tx.redemptionLine.findFirstOrThrow({
        where: { redemptionId: redemption.id },
      });
      expect(line.cogsTotal.toString()).toBe("10000"); // 4 * 2500

      const updated = await tx.redemption.findUniqueOrThrow({
        where: { id: redemption.id },
      });
      expect(updated.totalCogs.toString()).toBe("10000");

      const cleared = await tx.prizeBatch.findUniqueOrThrow({
        where: { id: batch.id },
      });
      expect(cleared.needsCosting).toBe(false);
      expect(cleared.unitCogs.toString()).toBe("2500");
    });
  });
});

describe("opname variance", () => {
  test("§15.8 — positive variance creates an adjustment batch at weighted-average cost", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 10, unitCogs: 1000 },
        { qty: 30, unitCogs: 2000 },
      ]);

      // (10*1000 + 30*2000) / 40 = 1750
      const avg = await weightedAverageCost(tx, shopId, prizeItemId);
      expect(avg.toString()).toBe("1750");
    });
  });

  test("§15.9 — negative variance consumes FIFO and is categorised OPNAME_LOSS", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 5, unitCogs: 1000 },
        { qty: 5, unitCogs: 3000 },
      ]);

      const result = await consumeFifo(tx, {
        ...consumeArgs(shopId, prizeItemId, 7),
        type: "OPNAME_LOSS",
      });

      // Shrinkage is an expense line separate from prize expense (§4.11), so
      // the movement type is what keeps the two apart in Phase 8's reports.
      expect(result.movement.type).toBe("OPNAME_LOSS");
      expect(result.consumptions.map((c) => c.qty)).toEqual([5, 2]);
      expect(result.totalCogs.toString()).toBe("11000");
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([0, 3]);
    });
  });
});

describe("restoring consumed stock", () => {
  test("§15.10 — a void restores the exact batches in the exact quantities", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 5, unitCogs: 1000 },
        { qty: 5, unitCogs: 2000 },
        { qty: 5, unitCogs: 3000 },
      ]);

      const consumed = await consumeFifo(tx, consumeArgs(shopId, prizeItemId, 8));
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([0, 2, 5]);

      const restored = await restoreConsumption(tx, {
        movementId: consumed.movement.id,
        shopId,
        prizeItemId,
        businessDate: BUSINESS_DATE,
        userId: null,
        reason: "redemption voided",
      });

      // Back to the starting position, batch by batch — not merely the same
      // total. A restore that dumped 8 units into one batch would corrupt both
      // FIFO order and the cost basis of every later consumption.
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([5, 5, 5]);
      expect(restored.movement.type).toBe("VOID_RESTORE");
      expect(restored.movement.qtyDelta).toBe(8);
      expect(restored.totalCogs.toString()).toBe("11000"); // 5*1000 + 3*2000
    });
  });

  test("a restore is refused twice", async () => {
    await withRollback(async (tx) => {
      const { shopId, prizeItemId } = await scenario(tx, [
        { qty: 5, unitCogs: 1000 },
      ]);
      const consumed = await consumeFifo(tx, consumeArgs(shopId, prizeItemId, 3));
      const args = {
        movementId: consumed.movement.id,
        shopId,
        prizeItemId,
        businessDate: BUSINESS_DATE,
        userId: null,
        reason: "first",
      };

      await restoreConsumption(tx, args);
      await expect(restoreConsumption(tx, args)).rejects.toThrow(
        /already been restored/i
      );
      expect(await remaining(tx, shopId, prizeItemId)).toEqual([5]);
    });
  });
});
