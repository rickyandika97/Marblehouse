/**
 * Manual stock adjustment (PRD §4.8, §7.4, §4.16; BUILD-LOG D-119).
 *
 * `adjustStock` shipped in Phase 4 with a route and a permission check, and
 * **no test and no caller**. It writes stock — a negative delta consumes FIFO
 * batches and a positive one creates an adjustment batch — so it sits squarely
 * inside CLAUDE.md's "money, stock and balance code needs a test before the
 * phase closes". D-119 gave it a UI, which is what makes the coverage urgent
 * rather than tidy: until now nothing could reach it except curl.
 *
 * These run inside `withRollback` because `adjustStock` takes the caller's
 * transaction, so nothing here is ever committed.
 *
 * What is worth proving rather than assuming:
 *
 *  - **A negative adjustment consumes FIFO, oldest first.** The whole cost
 *    basis depends on it (§4.8). An adjustment that took from the newest batch
 *    would overstate remaining stock value and understate the loss.
 *  - **`unitCogsAtConsumption` is recorded**, so shrinkage is valued at what
 *    the units actually cost — never a recomputed average (CLAUDE.md).
 *  - **A positive adjustment lands as `isAdjustment` and `needsCosting`.**
 *    Found stock has no invoice; pricing it at 0 silently would understate
 *    prize expense forever.
 *  - **Stock can never go negative** — checked at commit time, inside the
 *    transaction.
 *  - **The reason is mandatory and reaches both the movement and the audit
 *    row.** §4.16 exists so an owner reading back months later can tell
 *    breakage from theft from a counting error.
 *  - **Shop scoping holds**, so a manager cannot adjust another branch.
 */
import { describe, expect, it, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import {
  prisma,
  withRollback,
  makeShop,
  makePrize,
  makeBatch,
  makeActor,
  makeActorWithUser,
  remaining,
} from "./helpers";
import { adjustStock, adjustStockSchema } from "../stock";
import { InsufficientStockError } from "../inventory";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

afterAll(async () => {
  await prisma.$disconnect();
});

const BUSINESS_DATE = new Date("2026-08-19T00:00:00.000Z");

function actorFor(
  role: "OWNER" | "MANAGER" | "STAFF",
  shopIds: string[] = []
): Actor {
  return makeActor({ role, shopIds, businessDate: BUSINESS_DATE });
}

/**
 * A user row the foreign keys can point at. `adjustStock` writes
 * `StockMovement.userId` and `PrizeBatch.createdById`, so a fabricated id would
 * fail on the constraint rather than on the behaviour under test.
 */
async function realActor(
  tx: Prisma.TransactionClient,
  role: "OWNER" | "MANAGER" | "STAFF",
  shopIds: string[] = []
): Promise<Actor> {
  return makeActorWithUser(tx, { role, shopIds, businessDate: BUSINESS_DATE });
}

describe("adjustStockSchema", () => {
  const base = { shopId: "s", prizeItemId: "p", delta: 1, reason: "Broken" };

  it("refuses a zero delta", () => {
    // An adjustment of nothing is a mistake, not a no-op worth recording.
    expect(() => adjustStockSchema.parse({ ...base, delta: 0 })).toThrow();
  });

  it("refuses a missing or too-short reason", () => {
    expect(() => adjustStockSchema.parse({ ...base, reason: "" })).toThrow();
    expect(() => adjustStockSchema.parse({ ...base, reason: "x" })).toThrow();
  });

  it("refuses a fractional delta", () => {
    expect(() => adjustStockSchema.parse({ ...base, delta: 1.5 })).toThrow();
  });

  it("accepts a negative delta with a reason", () => {
    const parsed = adjustStockSchema.parse({ ...base, delta: -3, reason: "Damaged in transit" });
    expect(parsed.delta).toBe(-3);
  });
});

describe("negative adjustment — shrinkage, damage, correction", () => {
  it("consumes FIFO, oldest batch first", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");

      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 10, unitCogs: 1000, dayOffset: 0 });
      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 10, unitCogs: 2000, dayOffset: 1 });

      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: -4, reason: "Damaged" },
        tx
      );

      // The OLD batch is drawn down, not the new one.
      expect(await remaining(tx, shop.id, prize.id)).toEqual([6, 10]);
    });
  });

  it("splits across batches when one is not enough", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");

      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000, dayOffset: 0 });
      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 2000, dayOffset: 1 });

      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: -8, reason: "Stocktake correction" },
        tx
      );

      expect(await remaining(tx, shop.id, prize.id)).toEqual([0, 2]);
    });
  });

  it("records unitCogsAtConsumption, so the loss is valued at real cost", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");

      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000, dayOffset: 0 });
      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 3000, dayOffset: 1 });

      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: -7, reason: "Damaged" },
        tx
      );

      // StockConsumption reaches the prize through its batch, not directly.
      const rows = await tx.stockConsumption.findMany({
        where: { batch: { prizeItemId: prize.id } },
        orderBy: { unitCogsAtConsumption: "asc" },
      });

      // 5 @ 1000 + 2 @ 3000 = 11 000. NOT 7 × the 2000 average.
      const total = rows.reduce(
        (sum, r) => sum.plus(r.unitCogsAtConsumption.times(r.qty)),
        new Prisma.Decimal(0)
      );
      expect(total.toString()).toBe("11000");
    });
  });

  it("REFUSES to take more than is on hand", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");

      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 3, unitCogs: 1000 });

      // Stock may never go negative (CLAUDE.md), and the check is at commit
      // time inside the transaction — not a client-side guess.
      await expect(
        adjustStock(
          actor,
          { shopId: shop.id, prizeItemId: prize.id, delta: -4, reason: "Too many" },
          tx
        )
      ).rejects.toBeInstanceOf(InsufficientStockError);
    });
  });

  it("allows taking exactly the whole remaining stock", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");

      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 3, unitCogs: 1000 });

      const result = await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: -3, reason: "All broken" },
        tx
      );
      expect(result.onHand).toBe(0);
    });
  });

  it("writes a MANUAL_ADJUST movement carrying the reason", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");
      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000 });

      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: -2, reason: "Dropped by a customer" },
        tx
      );

      const move = await tx.stockMovement.findFirst({
        where: { prizeItemId: prize.id, type: "MANUAL_ADJUST" },
      });
      expect(move?.qtyDelta).toBe(-2);
      // §4.16: without this, an owner reading back cannot tell breakage from
      // theft from a counting error.
      expect(move?.reason).toBe("Dropped by a customer");
    });
  });
});

describe("positive adjustment — found stock", () => {
  it("creates an adjustment batch flagged for costing", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");

      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: 6, reason: "Found in the store room" },
        tx
      );

      const batch = await tx.prizeBatch.findFirst({
        where: { prizeItemId: prize.id, isAdjustment: true },
      });
      expect(batch?.qtyReceived).toBe(6);
      expect(batch?.qtyRemaining).toBe(6);
      // Found stock has no invoice. Leaving it silently at cost 0 would
      // understate prize expense for as long as those units last, so it is
      // flagged into the uncosted queue instead (§7.5).
      expect(batch?.needsCosting).toBe(true);
      expect(batch?.unitCogs.toString()).toBe("0");
      expect(batch?.note).toBe("Found in the store room");
    });
  });

  it("writes a MANUAL_ADJUST movement carrying the reason", async () => {
    // The two deltas write the movement from DIFFERENT places: a negative one
    // goes through `consumeFifo`, a positive one is written inline by
    // `adjustStock`. Testing only the negative path leaves the inline write
    // uncovered — removing `reason` there kept the suite green until this
    // existed.
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");

      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: 4, reason: "Found behind the counter" },
        tx
      );

      const move = await tx.stockMovement.findFirst({
        where: { prizeItemId: prize.id, type: "MANUAL_ADJUST" },
      });
      expect(move?.qtyDelta).toBe(4);
      expect(move?.reason).toBe("Found behind the counter");
    });
  });

  it("adds to on-hand", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");
      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 4, unitCogs: 1000 });

      const result = await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: 3, reason: "Recount" },
        tx
      );
      expect(result.onHand).toBe(7);
    });
  });

  it("is consumed LAST by FIFO, because it is received now", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");

      // An old batch, then found stock dated today.
      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000, dayOffset: 0 });
      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: 5, reason: "Found" },
        tx
      );

      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: -5, reason: "Damaged" },
        tx
      );

      // The 1970s-dated fixture batch goes first; the found stock survives.
      expect(await remaining(tx, shop.id, prize.id)).toEqual([0, 5]);
    });
  });
});

describe("audit and permissions", () => {
  it("audits the adjustment with the delta and the reason", async () => {
    await withRollback(async (tx) => {
      const shop = await makeShop(tx);
      const prize = await makePrize(tx);
      const actor = await realActor(tx, "OWNER");
      await makeBatch(tx, { shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000 });

      await adjustStock(
        actor,
        { shopId: shop.id, prizeItemId: prize.id, delta: -2, reason: "Water damage" },
        tx
      );

      const audit = await tx.auditLog.findFirst({
        where: { entityId: prize.id, action: "STOCK_ADJUST" },
      });
      expect(audit?.after).toMatchObject({ delta: -2 });
      expect(audit?.reason).toBe("Water damage");
      expect(audit?.shopId).toBe(shop.id);
    });
  });

  /**
   * BOTH directions, and the foreign shop is STOCKED on purpose.
   *
   * The first version of this test gave the foreign shop no stock, so the
   * negative case threw `InsufficientStockError` — which is itself an
   * `AppError`, so `rejects.toBeInstanceOf(AppError)` passed while
   * `assertShopAccess` was removed. A permission test that a stock error can
   * satisfy proves nothing about the permission (D-34, D-69). Asserting the
   * FORBIDDEN code, against a shop that has plenty of stock, is what makes the
   * mutation go red.
   */
  it("stops a MANAGER adjusting DOWN at a branch they do not manage", async () => {
    await withRollback(async (tx) => {
      const mine = await makeShop(tx, "Mine");
      const theirs = await makeShop(tx, "Theirs");
      const prize = await makePrize(tx);
      const manager = await realActor(tx, "MANAGER", [mine.id]);
      // Stocked, so a refusal cannot be blamed on insufficient stock.
      await makeBatch(tx, { shopId: theirs.id, prizeItemId: prize.id, qty: 50, unitCogs: 1000 });

      await expect(
        adjustStock(
          manager,
          { shopId: theirs.id, prizeItemId: prize.id, delta: -1, reason: "Not mine" },
          tx
        )
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("stops a MANAGER adjusting UP at a branch they do not manage", async () => {
    // The positive branch never touches FIFO, so it is the cleaner proof that
    // the guard runs before either path — and it is a separate code path that
    // the negative test says nothing about.
    await withRollback(async (tx) => {
      const mine = await makeShop(tx, "Mine");
      const theirs = await makeShop(tx, "Theirs");
      const prize = await makePrize(tx);
      const manager = await realActor(tx, "MANAGER", [mine.id]);

      await expect(
        adjustStock(
          manager,
          { shopId: theirs.id, prizeItemId: prize.id, delta: 3, reason: "Not mine" },
          tx
        )
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  it("lets a MANAGER adjust a branch they DO manage", async () => {
    await withRollback(async (tx) => {
      const mine = await makeShop(tx, "Mine");
      const prize = await makePrize(tx);
      const manager = await realActor(tx, "MANAGER", [mine.id]);
      await makeBatch(tx, { shopId: mine.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000 });

      const result = await adjustStock(
        manager,
        { shopId: mine.id, prizeItemId: prize.id, delta: -1, reason: "Broken" },
        tx
      );
      expect(result.onHand).toBe(4);
    });
  });
});
