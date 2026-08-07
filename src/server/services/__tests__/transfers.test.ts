/**
 * Transfer tests (PRD §4.10, §15).
 *
 * §15's integration list asks for one thing specifically:
 *
 *   "Transfer dispatch → receive round trip preserves total quantity and total
 *    cost across the two shops."
 *
 * That is `conserves quantity and cost across a dispatch → receive round trip`
 * below. The rest guard the mechanisms that make it true — above all that a
 * transferred batch keeps its ORIGINAL `receivedAt`, because getting that wrong
 * inverts the cost basis at the destination and only becomes visible after a
 * later consumption. D-30 caught exactly that defect one layer down, in the
 * engine; this suite is what stops it reappearing at the transfer layer.
 */
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  BUSINESS_DATE,
  makeBatch,
  makePrize,
  makeShop,
  remaining,
  uniq,
  withRollback,
} from "./helpers";
import {
  cancelTransfer,
  dispatchTransfer,
  receiveTransfer,
} from "@/server/services/transfers";
import { consumeFifo } from "@/server/services/inventory";
import type { Actor } from "@/server/auth/context";

/**
 * A minimal Actor. Transfers only read `userId`, `role` and `assignedShopIds`,
 * so a full session is unnecessary — and building one would couple this suite
 * to Better Auth for no gain.
 */
function actorFor(shopIds: string[], role: Actor["role"] = "MANAGER"): Actor {
  return {
    sessionId: `sess-${uniq()}`,
    userId: `user-${uniq()}`,
    username: `u${uniq()}`,
    displayName: "Transfer Tester",
    role,
    isActive: true,
    mustChangePassword: false,
    canEnterCost: false,
    defaultShopId: shopIds[0] ?? null,
    assignedShopIds: shopIds,
    businessDate: BUSINESS_DATE,
    workSession: null,
  };
}

/** A real user row, since PrizeTransfer.dispatchedById is a foreign key. */
async function makeUser(tx: Prisma.TransactionClient, role: Actor["role"] = "MANAGER") {
  const id = uniq();
  return tx.user.create({
    data: {
      email: `transfer-${id}@marblehouse.invalid`,
      name: `Transfer ${id}`,
      username: `transfer-${id}`,
      displayName: `Transfer ${id}`,
      role,
    },
    select: { id: true },
  });
}

async function setup(
  tx: Prisma.TransactionClient,
  opts: { allowDirectTransfer?: boolean } = {}
) {
  const [from, to] = await Promise.all([makeShop(tx, "Source"), makeShop(tx, "Dest")]);
  if (opts.allowDirectTransfer) {
    await tx.shop.update({
      where: { id: from.id },
      data: { allowDirectTransfer: true },
    });
  }
  const prize = await makePrize(tx);
  const user = await makeUser(tx);
  const actor = { ...actorFor([from.id, to.id]), userId: user.id };
  return { from, to, prize, actor };
}

describe("transfer dispatch", () => {
  it("consumes at source and leaves the stock in neither branch while in transit", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 10,
        unitCogs: 1000,
        dayOffset: 0,
      });

      const transfer = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 4 }] },
        BUSINESS_DATE
      );

      expect(transfer.status).toBe("IN_TRANSIT");
      // Source is down by 4...
      expect(await remaining(tx, from.id, prize.id)).toEqual([6]);
      // ...and the destination does not have them yet. §4.10: in transit is in
      // neither on-hand figure.
      expect(await remaining(tx, to.id, prize.id)).toEqual([]);
    });
  });

  it("refuses to dispatch more than the source holds, writing nothing", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 3,
        unitCogs: 1000,
      });

      await expect(
        dispatchTransfer(
          tx,
          actor,
          { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 5 }] },
          BUSINESS_DATE
        )
      ).rejects.toThrow(/only 3 in stock/i);

      // No partial write: the batch is untouched.
      expect(await remaining(tx, from.id, prize.id)).toEqual([3]);
    });
  });

  it("refuses a transfer to the same shop", async () => {
    await withRollback(async (tx) => {
      const { from, prize, actor } = await setup(tx);
      await expect(
        dispatchTransfer(
          tx,
          actor,
          { fromShopId: from.id, toShopId: from.id, lines: [{ prizeItemId: prize.id, qty: 1 }] },
          BUSINESS_DATE
        )
      ).rejects.toThrow(/two different branches/i);
    });
  });

  it("refuses a manager who is not assigned to BOTH ends (§4.10)", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, { shopId: from.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000 });

      // Assigned to the source only — the destination is somebody else's branch.
      const sourceOnly = { ...actor, assignedShopIds: [from.id] };

      await expect(
        dispatchTransfer(
          tx,
          sourceOnly,
          { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 1 }] },
          BUSINESS_DATE
        )
      ).rejects.toThrow();

      expect(await remaining(tx, from.id, prize.id)).toEqual([5]);
    });
  });
});

describe("transfer receive", () => {
  it("conserves quantity and cost across a dispatch → receive round trip (§15)", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      // Two batches at different costs, so a round trip that averaged them
      // would show up as a changed total.
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 5,
        unitCogs: 1000,
        dayOffset: 0,
      });
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 5,
        unitCogs: 3000,
        dayOffset: 1,
      });

      const valueAt = async (shopId: string) => {
        const batches = await tx.prizeBatch.findMany({
          where: { shopId, prizeItemId: prize.id, isVoid: false },
          select: { qtyRemaining: true, unitCogs: true },
        });
        return batches.reduce(
          (acc, b) => ({
            qty: acc.qty + b.qtyRemaining,
            value: acc.value.plus(b.unitCogs.times(b.qtyRemaining)),
          }),
          { qty: 0, value: new Prisma.Decimal(0) }
        );
      };

      const before = await valueAt(from.id);

      // 7 units spans both batches: all 5 at 1000, then 2 at 3000.
      const dispatched = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 7 }] },
        BUSINESS_DATE
      );
      await receiveTransfer(tx, actor, dispatched.id, BUSINESS_DATE);

      const afterFrom = await valueAt(from.id);
      const afterTo = await valueAt(to.id);

      // Total quantity across both shops is unchanged...
      expect(afterFrom.qty + afterTo.qty).toBe(before.qty);
      // ...and so is total cost. Nothing was invented or lost in the move.
      expect(afterFrom.value.plus(afterTo.value).toString()).toBe(before.value.toString());

      // The destination got the exact split, not one averaged batch.
      const destBatches = await tx.prizeBatch.findMany({
        where: { shopId: to.id, prizeItemId: prize.id },
        orderBy: [{ receivedAt: "asc" }],
        select: { qtyRemaining: true, unitCogs: true },
      });
      expect(destBatches.map((b) => [b.qtyRemaining, b.unitCogs.toNumber()])).toEqual([
        [5, 1000],
        [2, 3000],
      ]);
    });
  });

  it("preserves receivedAt so a transferred batch keeps FIFO priority (§4.10)", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);

      // An OLD, cheap batch at the source.
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 5,
        unitCogs: 500,
        dayOffset: 0,
      });
      // A NEWER, expensive batch already sitting at the destination.
      await makeBatch(tx, {
        shopId: to.id,
        prizeItemId: prize.id,
        qty: 5,
        unitCogs: 9000,
        dayOffset: 10,
      });

      const dispatched = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 5 }] },
        BUSINESS_DATE
      );
      await receiveTransfer(tx, actor, dispatched.id, BUSINESS_DATE);

      // Consume 5 at the destination. If receivedAt were stamped at arrival,
      // the transferred batch would look NEWEST and the 9000 batch would be
      // consumed first — inverting the cost basis exactly as §4.10 warns.
      const result = await consumeFifo(tx, {
        shopId: to.id,
        prizeItemId: prize.id,
        qty: 5,
        type: "REDEEM",
        businessDate: BUSINESS_DATE,
        userId: actor.userId,
      });

      // The old cheap box moved branches and is STILL consumed first.
      expect(result.totalCogs.toNumber()).toBe(2500);
    });
  });

  it("keeps an uncosted batch uncosted after it moves", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 4,
        unitCogs: 0,
        needsCosting: true,
      });

      const dispatched = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 4 }] },
        BUSINESS_DATE
      );
      await receiveTransfer(tx, actor, dispatched.id, BUSINESS_DATE);

      // Still in the owner's queue at the destination — a move must not
      // launder an unpriced batch into a priced one.
      const dest = await tx.prizeBatch.findFirst({
        where: { shopId: to.id, prizeItemId: prize.id },
        select: { needsCosting: true, unitCogs: true },
      });
      expect(dest?.needsCosting).toBe(true);
      expect(dest?.unitCogs.toNumber()).toBe(0);
    });
  });

  it("refuses to receive the same transfer twice", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, { shopId: from.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000 });

      const dispatched = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 2 }] },
        BUSINESS_DATE
      );
      await receiveTransfer(tx, actor, dispatched.id, BUSINESS_DATE);

      await expect(
        receiveTransfer(tx, actor, dispatched.id, BUSINESS_DATE)
      ).rejects.toThrow(/already been received/i);

      // Critically: the second attempt did not duplicate the stock.
      expect(await remaining(tx, to.id, prize.id)).toEqual([2]);
    });
  });
});

describe("direct transfer (§4.10 allowDirectTransfer)", () => {
  it("lands the stock at the destination in one step when the shop allows it", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx, { allowDirectTransfer: true });
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 6,
        unitCogs: 1500,
      });

      const transfer = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 6 }] },
        BUSINESS_DATE
      );

      // No separate receive call was made.
      expect(transfer.status).toBe("RECEIVED");
      expect(await remaining(tx, from.id, prize.id)).toEqual([0]);
      expect(await remaining(tx, to.id, prize.id)).toEqual([6]);
    });
  });

  it("stays two-step when the shop does not allow it", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, { shopId: from.id, prizeItemId: prize.id, qty: 6, unitCogs: 1500 });

      const transfer = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 6 }] },
        BUSINESS_DATE
      );

      expect(transfer.status).toBe("IN_TRANSIT");
      expect(await remaining(tx, to.id, prize.id)).toEqual([]);
    });
  });
});

describe("transfer cancel", () => {
  it("restores the exact source batches (§4.10)", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 5,
        unitCogs: 500,
        dayOffset: 0,
      });
      await makeBatch(tx, {
        shopId: from.id,
        prizeItemId: prize.id,
        qty: 5,
        unitCogs: 3000,
        dayOffset: 1,
      });

      const dispatched = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 7 }] },
        BUSINESS_DATE
      );
      expect(await remaining(tx, from.id, prize.id)).toEqual([0, 3]);

      const cancelled = await cancelTransfer(
        tx,
        actor,
        dispatched.id,
        "Van broke down",
        BUSINESS_DATE
      );

      expect(cancelled.status).toBe("CANCELLED");
      // Back into the SAME batches, not one merged batch — the cheap one is
      // whole again and still first.
      expect(await remaining(tx, from.id, prize.id)).toEqual([5, 5]);
      expect(await remaining(tx, to.id, prize.id)).toEqual([]);
    });
  });

  it("refuses a second cancel, so stock cannot be invented (D-27)", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, { shopId: from.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000 });

      const dispatched = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 3 }] },
        BUSINESS_DATE
      );
      await cancelTransfer(tx, actor, dispatched.id, "Mis-keyed", BUSINESS_DATE);

      await expect(
        cancelTransfer(tx, actor, dispatched.id, "Again", BUSINESS_DATE)
      ).rejects.toThrow(/already cancelled/i);

      expect(await remaining(tx, from.id, prize.id)).toEqual([5]);
    });
  });

  it("refuses to cancel a transfer that has already been received", async () => {
    await withRollback(async (tx) => {
      const { from, to, prize, actor } = await setup(tx);
      await makeBatch(tx, { shopId: from.id, prizeItemId: prize.id, qty: 5, unitCogs: 1000 });

      const dispatched = await dispatchTransfer(
        tx,
        actor,
        { fromShopId: from.id, toShopId: to.id, lines: [{ prizeItemId: prize.id, qty: 3 }] },
        BUSINESS_DATE
      );
      await receiveTransfer(tx, actor, dispatched.id, BUSINESS_DATE);

      await expect(
        cancelTransfer(tx, actor, dispatched.id, "Too late", BUSINESS_DATE)
      ).rejects.toThrow(/already been received/i);
    });
  });
});
