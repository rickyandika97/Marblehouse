/**
 * The inventory drill-down reads (D-156): batches per item, where a lot's
 * units went, and the transfer FIFO preview.
 *
 * These write real rows and clean up in `afterEach`, following
 * `prizes.test.ts` — the functions under test use the global `prisma` client
 * (they are reads and open no transaction), so they cannot see fixture data
 * created inside `withRollback`'s uncommitted transaction.
 *
 * What is worth proving here rather than assuming:
 *
 *  - **The cost gate holds on BOTH branches** of all three reads. D-34's rule:
 *    a passing test for the owner says nothing about the manager, and the
 *    dangerous direction is the one that leaks. Every assertion below checks
 *    the restricted shape has NO cost key at all — not that it is null, which
 *    a `delete`-based implementation would also satisfy.
 *  - **`previewTransferPlan` agrees with `consumeFifo`.** A preview that
 *    disagrees with the engine is worse than no preview, because the sender
 *    acts on it. This runs both against the same fixture and compares the
 *    batch split element by element.
 *  - **Ref labels resolve to names, not ids**, including the transfer case
 *    naming the destination branch.
 *  - **A batch id from another branch is a 403, not an empty list** — an empty
 *    list would confirm the lot exists to someone who may not see it.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, uniq, makeActorWithUser, BUSINESS_DATE } from "./helpers";
import {
  listBatchConsumption,
  listBatchesForItem,
} from "../stock";
import { previewTransferPlan } from "../transfers";
import { consumeFifo } from "../inventory";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

const TEST_SKU_PREFIX = "ZDRL";
const TEST_CODE_PREFIX = "ZDRS";

const prizeIds: string[] = [];
const shopIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await prisma.stockConsumption.deleteMany({
    where: { batch: { prizeItemId: { in: prizeIds } } },
  });
  await prisma.stockMovement.deleteMany({
    where: { OR: [{ prizeItemId: { in: prizeIds } }, { shopId: { in: shopIds } }] },
  });
  await prisma.prizeBatch.deleteMany({
    where: { OR: [{ prizeItemId: { in: prizeIds } }, { shopId: { in: shopIds } }] },
  });
  await prisma.prizeItem.deleteMany({ where: { id: { in: prizeIds } } });
  await prisma.prizeItem.deleteMany({
    where: { sku: { startsWith: TEST_SKU_PREFIX } },
  });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  await prisma.shop.deleteMany({
    where: { code: { startsWith: TEST_CODE_PREFIX } },
  });

  prizeIds.length = 0;
  shopIds.length = 0;
  userIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeUser(
  role: "OWNER" | "MANAGER" | "STAFF",
  opts: { assignedShopIds?: string[]; canEnterCost?: boolean } = {}
): Promise<Actor> {
  const actor = await makeActorWithUser(
    prisma as unknown as Prisma.TransactionClient,
    {
      role,
      shopIds: opts.assignedShopIds ?? [],
      canEnterCost: opts.canEnterCost,
      businessDate: BUSINESS_DATE,
    }
  );
  userIds.push(actor.userId);
  return actor;
}

async function makeShop() {
  const id = uniq();
  const shop = await prisma.shop.create({
    data: {
      code: `${TEST_CODE_PREFIX}${id.slice(0, 4)}`.toUpperCase(),
      name: `Drill Branch ${id}`,
      timezone: "Asia/Jakarta",
    },
  });
  shopIds.push(shop.id);
  return shop;
}

async function makePrize() {
  const prize = await prisma.prizeItem.create({
    data: {
      sku: `${TEST_SKU_PREFIX}-${uniq()}`,
      name: `Drill Prize ${uniq()}`,
      ticketCost: 100,
    },
  });
  prizeIds.push(prize.id);
  return prize;
}

/** A committed batch. `dayOffset` sets FIFO position via `receivedAt`. */
async function makeBatch(args: {
  shopId: string;
  prizeItemId: string;
  qty: number;
  unitCogs: number;
  dayOffset?: number;
  batchCode?: string;
}) {
  const receivedAt = new Date("2026-01-01T00:00:00.000Z");
  receivedAt.setUTCDate(receivedAt.getUTCDate() + (args.dayOffset ?? 0));
  return prisma.prizeBatch.create({
    data: {
      shopId: args.shopId,
      prizeItemId: args.prizeItemId,
      qtyReceived: args.qty,
      qtyRemaining: args.qty,
      unitCogs: new Prisma.Decimal(args.unitCogs),
      batchCode: args.batchCode ?? null,
      receivedAt,
    },
  });
}

describe("listBatchesForItem", () => {
  it("returns every lot in FIFO order, including drained ones", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    const owner = await makeUser("OWNER");

    // Created newest-first on purpose: the ordering under test is receivedAt,
    // not insertion order.
    await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 3000, dayOffset: 10, batchCode: "NEW" });
    await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 0, unitCogs: 1000, dayOffset: 0, batchCode: "OLD" });

    const rows = await listBatchesForItem(owner, {
      shopId: shop.id,
      prizeItemId: prize.id,
    });

    expect(rows.map((r) => r.batchCode)).toEqual(["OLD", "NEW"]);
    // A drained lot is exactly the one you want when asking where stock went.
    expect(rows[0]!.qtyRemaining).toBe(0);
  });

  it("gives an owner the cost, and a plain manager NO cost key at all", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 4, unitCogs: 2500 });

    const owner = await makeUser("OWNER");
    const costed = await listBatchesForItem(owner, {
      shopId: shop.id,
      prizeItemId: prize.id,
    });
    expect(costed[0]).toHaveProperty("unitCogs", "2500");
    expect(costed[0]).toHaveProperty("remainingValue", "10000");

    // The other branch of D-34: a manager WITHOUT Purchasing.
    const manager = await makeUser("MANAGER", { assignedShopIds: [shop.id] });
    const restricted = await listBatchesForItem(manager, {
      shopId: shop.id,
      prizeItemId: prize.id,
    });
    expect(restricted[0]!.qtyRemaining).toBe(4);
    // Absent, not null — a delete-based strip would pass a null check.
    expect(restricted[0]).not.toHaveProperty("unitCogs");
    expect(restricted[0]).not.toHaveProperty("remainingValue");
    expect(restricted[0]).not.toHaveProperty("needsCosting");
  });

  it("gives a Purchasing manager the cost at their OWN shop", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 2, unitCogs: 700 });

    const purchasing = await makeUser("MANAGER", {
      assignedShopIds: [shop.id],
      canEnterCost: true,
    });
    const rows = await listBatchesForItem(purchasing, {
      shopId: shop.id,
      prizeItemId: prize.id,
    });
    expect(rows[0]).toHaveProperty("unitCogs", "700");
  });

  it("refuses a shop the manager is not assigned to", async () => {
    const mine = await makeShop();
    const theirs = await makeShop();
    const prize = await makePrize();
    const manager = await makeUser("MANAGER", { assignedShopIds: [mine.id] });

    await expect(
      listBatchesForItem(manager, { shopId: theirs.id, prizeItemId: prize.id })
    ).rejects.toThrow(AppError);
  });
});

describe("listBatchConsumption", () => {
  /** Draw `qty` down through the real engine so the rows are genuine. */
  async function consume(
    actor: Actor,
    args: { shopId: string; prizeItemId: string; qty: number; type?: "REDEEM" | "DAMAGE"; refType?: string; refId?: string; reason?: string }
  ) {
    return prisma.$transaction((tx) =>
      consumeFifo(tx, {
        shopId: args.shopId,
        prizeItemId: args.prizeItemId,
        qty: args.qty,
        type: args.type ?? "REDEEM",
        businessDate: BUSINESS_DATE,
        userId: actor.userId,
        refType: args.refType ?? null,
        refId: args.refId ?? null,
        reason: args.reason ?? null,
      })
    );
  }

  it("reports who drew the lot down, when, and how much", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    const owner = await makeUser("OWNER");
    const batch = await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 10, unitCogs: 500 });

    await consume(owner, {
      shopId: shop.id,
      prizeItemId: prize.id,
      qty: 3,
      type: "DAMAGE",
      reason: "Water damage",
    });

    const rows = await listBatchConsumption(owner, { batchId: batch.id });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.qty).toBe(3);
    expect(rows[0]!.ref.type).toBe("DAMAGE");
    expect(rows[0]!.reason).toBe("Water damage");
    // Read from the User row rather than the Actor: `makeActorWithUser` builds
    // the two display names from separate `uniq()` calls, so they differ. The
    // database is what the service resolves against and what matters here.
    const ownerRow = await prisma.user.findUnique({
      where: { id: owner.userId },
      select: { displayName: true },
    });
    expect(rows[0]!.staffName).toBe(ownerRow!.displayName);
  });

  it("hides the cost from a plain manager and shows it to an owner", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    const owner = await makeUser("OWNER");
    const batch = await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 10, unitCogs: 500 });

    await consume(owner, { shopId: shop.id, prizeItemId: prize.id, qty: 2 });

    const costed = await listBatchConsumption(owner, { batchId: batch.id });
    expect(costed[0]).toHaveProperty("unitCogs", "500");
    expect(costed[0]).toHaveProperty("lineValue", "1000");

    const manager = await makeUser("MANAGER", { assignedShopIds: [shop.id] });
    const restricted = await listBatchConsumption(manager, { batchId: batch.id });
    expect(restricted[0]!.qty).toBe(2);
    expect(restricted[0]).not.toHaveProperty("unitCogs");
    expect(restricted[0]).not.toHaveProperty("lineValue");
  });

  it("resolves a redemption ref to the customer's name", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    const owner = await makeUser("OWNER");
    const batch = await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 10, unitCogs: 500 });

    const customer = await prisma.customer.create({
      data: {
        name: `Drill Customer ${uniq()}`,
        phoneRaw: `0812${uniq().slice(0, 6)}`,
        phoneNormalized: `+6281${uniq()}`,
      },
    });
    const redemption = await prisma.redemption.create({
      data: {
        shopId: shop.id,
        customerId: customer.id,
        userId: owner.userId,
        totalTickets: 100,
        totalCogs: new Prisma.Decimal(0),
        businessDate: BUSINESS_DATE,
      },
    });

    await consume(owner, {
      shopId: shop.id,
      prizeItemId: prize.id,
      qty: 1,
      refType: "Redemption",
      refId: redemption.id,
    });

    const rows = await listBatchConsumption(owner, { batchId: batch.id });
    expect(rows[0]!.ref.label).toBe(customer.name);

    await prisma.redemption.deleteMany({ where: { id: redemption.id } });
    await prisma.customer.deleteMany({ where: { id: customer.id } });
  });

  it("names the destination branch for a transfer ref", async () => {
    const from = await makeShop();
    const to = await makeShop();
    const prize = await makePrize();
    const owner = await makeUser("OWNER");
    const batch = await makeBatch({ shopId: from.id, prizeItemId: prize.id, qty: 10, unitCogs: 500 });

    const transfer = await prisma.prizeTransfer.create({
      data: {
        fromShopId: from.id,
        toShopId: to.id,
        dispatchedById: owner.userId,
        businessDate: BUSINESS_DATE,
      },
    });

    await consume(owner, {
      shopId: from.id,
      prizeItemId: prize.id,
      qty: 4,
      refType: "PrizeTransfer",
      refId: transfer.id,
    });

    const rows = await listBatchConsumption(owner, { batchId: batch.id });
    expect(rows[0]!.ref.label).toBe(`To ${to.name}`);

    await prisma.prizeTransfer.deleteMany({ where: { id: transfer.id } });
  });

  it("refuses a batch belonging to a shop the manager does not manage", async () => {
    const mine = await makeShop();
    const theirs = await makeShop();
    const prize = await makePrize();
    const batch = await makeBatch({ shopId: theirs.id, prizeItemId: prize.id, qty: 5, unitCogs: 100 });

    const manager = await makeUser("MANAGER", { assignedShopIds: [mine.id] });

    // A 403, not an empty list: an empty list still confirms the lot exists.
    await expect(
      listBatchConsumption(manager, { batchId: batch.id })
    ).rejects.toThrow(AppError);
  });
});

describe("previewTransferPlan", () => {
  it("predicts EXACTLY the split consumeFifo goes on to make", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    const owner = await makeUser("OWNER");

    const oldest = await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 3, unitCogs: 1000, dayOffset: 0 });
    const middle = await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 4, unitCogs: 2000, dayOffset: 5 });
    await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 9, unitCogs: 3000, dayOffset: 9 });

    // 6 units spans the first two lots and stops partway through the second.
    const preview = await previewTransferPlan(owner, {
      fromShopId: shop.id,
      lines: [{ prizeItemId: prize.id, qty: 6 }],
    });

    const actual = await consume(owner, { shopId: shop.id, prizeItemId: prize.id, qty: 6 });

    expect(preview[0]!.lots.map((l) => ({ batchId: l.batchId, qty: l.qty }))).toEqual(
      actual.consumptions.map((c) => ({ batchId: c.batchId, qty: c.qty }))
    );
    expect(preview[0]!.lots.map((l) => l.batchId)).toEqual([oldest.id, middle.id]);
    expect(preview[0]!.lots.map((l) => l.qty)).toEqual([3, 3]);
  });

  async function consume(
    actor: Actor,
    args: { shopId: string; prizeItemId: string; qty: number }
  ) {
    return prisma.$transaction((tx) =>
      consumeFifo(tx, {
        shopId: args.shopId,
        prizeItemId: args.prizeItemId,
        qty: args.qty,
        type: "TRANSFER_OUT",
        businessDate: BUSINESS_DATE,
        userId: actor.userId,
      })
    );
  }

  it("flags a line the branch cannot cover instead of throwing", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    const owner = await makeUser("OWNER");
    await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 2, unitCogs: 100 });

    const preview = await previewTransferPlan(owner, {
      fromShopId: shop.id,
      lines: [{ prizeItemId: prize.id, qty: 5 }],
    });

    // A preview warns; the authoritative refusal is still at dispatch.
    expect(preview[0]!.short).toBe(true);
    expect(preview[0]!.onHand).toBe(2);
  });

  it("writes nothing — stock is untouched by a preview", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    const owner = await makeUser("OWNER");
    const batch = await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 8, unitCogs: 100 });

    await previewTransferPlan(owner, {
      fromShopId: shop.id,
      lines: [{ prizeItemId: prize.id, qty: 5 }],
    });

    const after = await prisma.prizeBatch.findUnique({ where: { id: batch.id } });
    expect(after!.qtyRemaining).toBe(8);
    const movements = await prisma.stockMovement.count({
      where: { shopId: shop.id, prizeItemId: prize.id },
    });
    expect(movements).toBe(0);
  });

  it("omits every cost key for a plain manager", async () => {
    const shop = await makeShop();
    const prize = await makePrize();
    await makeBatch({ shopId: shop.id, prizeItemId: prize.id, qty: 5, unitCogs: 900 });

    const owner = await makeUser("OWNER");
    const costed = await previewTransferPlan(owner, {
      fromShopId: shop.id,
      lines: [{ prizeItemId: prize.id, qty: 2 }],
    });
    expect(costed[0]!.lots[0]).toHaveProperty("unitCogs", "900");
    expect(costed[0]!.lots[0]).toHaveProperty("lineValue", "1800");

    const manager = await makeUser("MANAGER", { assignedShopIds: [shop.id] });
    const restricted = await previewTransferPlan(manager, {
      fromShopId: shop.id,
      lines: [{ prizeItemId: prize.id, qty: 2 }],
    });
    expect(restricted[0]!.lots[0]!.qty).toBe(2);
    expect(restricted[0]!.lots[0]).not.toHaveProperty("unitCogs");
    expect(restricted[0]!.lots[0]).not.toHaveProperty("lineValue");
  });
});
