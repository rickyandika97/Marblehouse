/**
 * Opname tests (PRD §4.11, §15.8, §15.9).
 *
 * §15 asks for two behaviours that Phase 4 proved against `inventory.ts`
 * directly (D-29), because their ROUTES were Phase 5:
 *
 *   §15.8  positive variance creates an adjustment batch at weighted average
 *   §15.9  negative variance consumes FIFO as OPNAME_LOSS, not REDEEM
 *
 * D-29 promised that when Phase 5 built the opname flow it would wire it to
 * those functions and add route-level tests rather than reimplement the
 * arithmetic. This file keeps that promise — the same two behaviours, now
 * asserted through `commitOpname`.
 *
 * The third thing under test has no engine equivalent: §4.11's anti-anchoring
 * rule. `startOpname` must not tell the tablet what the system count is.
 *
 * These write real rows and clean up in `afterEach`, following
 * `redemption.test.ts`: the service opens its own transactions, so it cannot
 * run inside `withRollback`'s.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { prisma, makeShop, makePrize, makeBatch, uniq } from "./helpers";
import {
  commitOpname,
  saveOpnameLines,
  startOpname,
  getOpname,
} from "../opname";
import type { Actor } from "@/server/auth/context";

const shopIds: string[] = [];
const prizeIds: string[] = [];
const sessionIds: string[] = [];

const BUSINESS_DATE = new Date("2026-01-15T00:00:00.000Z");

afterEach(async () => {
  await prisma.opnameLine.deleteMany({
    where: { sessionId: { in: sessionIds } },
  });
  await prisma.opnameSession.deleteMany({ where: { id: { in: sessionIds } } });
  await prisma.auditLog.deleteMany({ where: { entityId: { in: sessionIds } } });
  await prisma.stockConsumption.deleteMany({
    where: { batch: { shopId: { in: shopIds } } },
  });
  await prisma.stockMovement.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.prizeBatch.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.shopPrizeConfig.deleteMany({
    where: { shopId: { in: shopIds } },
  });
  await prisma.prizeItem.deleteMany({ where: { id: { in: prizeIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  sessionIds.length = 0;
  prizeIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function fixture(batches: Array<{ qty: number; unitCogs: number }>) {
  const shop = await makeShop(prisma, "Opname");
  const prize = await makePrize(prisma);
  shopIds.push(shop.id);
  prizeIds.push(prize.id);

  for (const [i, b] of batches.entries()) {
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

  const user = await prisma.user.findFirstOrThrow();

  const ownerActor = {
    sessionId: `sess-${uniq()}`,
    userId: user.id,
    username: user.username ?? "test",
    displayName: user.displayName,
    isOwner: true,
    shopRoles: new Map(),
    isActive: true,
    mustChangePassword: false,
    defaultShopId: null,
    businessDate: BUSINESS_DATE,
    workSession: null,
  } as unknown as Actor;

  const managerActor = {
    ...ownerActor,
    isOwner: false,
    shopRoles: new Map([[shop.id, { role: "MANAGER", canEnterCost: false }]]),
  } as unknown as Actor;

  return { shopId: shop.id, prizeItemId: prize.id, ownerActor, managerActor };
}

async function track<T extends { id: string }>(p: Promise<T>): Promise<T> {
  const session = await p;
  sessionIds.push(session.id);
  return session;
}

describe("opname anti-anchoring (§4.11)", () => {
  it("does NOT reveal the system quantity when a count is started", async () => {
    const { shopId, ownerActor } = await fixture([{ qty: 40, unitCogs: 1000 }]);

    const session = await track(startOpname(ownerActor, { shopId }));

    // The whole control: a counter who can see "40" will find 40.
    //
    // Asserted on the KEYS rather than by scanning the JSON for "40". A
    // substring scan passes or fails depending on whether a random cuid
    // happens to contain those digits, which is how this test first failed —
    // flakily, and for a reason that had nothing to do with the control.
    const serialized = JSON.stringify(session);
    expect(serialized).not.toMatch(/systemQty|qtyRemaining|onHand/i);

    expect(session.items).toHaveLength(1);
    for (const item of session.items) {
      expect(Object.keys(item).sort()).toEqual(["id", "isActive", "name", "sku"]);
    }
  });

  it("reveals the variance only once counted quantities are saved", async () => {
    const { shopId, prizeItemId, ownerActor } = await fixture([
      { qty: 40, unitCogs: 1000 },
    ]);
    const session = await track(startOpname(ownerActor, { shopId }));

    const saved = await saveOpnameLines(ownerActor, session.id, {
      lines: [{ prizeItemId, countedQty: 37 }],
    });

    expect(saved.lines[0]).toMatchObject({
      systemQty: 40,
      countedQty: 37,
      variance: -3,
    });
  });
});

describe("opname commit — negative variance (§15.9)", () => {
  it("consumes FIFO and categorises the movement OPNAME_LOSS, never REDEEM", async () => {
    const { shopId, prizeItemId, ownerActor } = await fixture([
      { qty: 5, unitCogs: 1000 },
      { qty: 5, unitCogs: 3000 },
    ]);
    const session = await track(startOpname(ownerActor, { shopId }));

    // Counted 3 short of 10.
    await saveOpnameLines(ownerActor, session.id, {
      lines: [{ prizeItemId, countedQty: 7 }],
    });
    await commitOpname(ownerActor, session.id, BUSINESS_DATE);

    const movements = await prisma.stockMovement.findMany({
      where: { shopId, prizeItemId },
      select: { type: true, qtyDelta: true },
    });
    expect(movements).toHaveLength(1);
    // Shrinkage, not a redemption. The owner reads these as different things.
    expect(movements[0]?.type).toBe("OPNAME_LOSS");

    // FIFO: the 3 units came from the OLDEST batch, at 1000 each.
    const consumptions = await prisma.stockConsumption.findMany({
      where: { batch: { shopId } },
      select: { qty: true, unitCogsAtConsumption: true },
    });
    expect(consumptions).toHaveLength(1);
    const [consumption] = consumptions;
    expect(consumption?.qty).toBe(3);
    expect(consumption?.unitCogsAtConsumption.toNumber()).toBe(1000);

    const batches = await prisma.prizeBatch.findMany({
      where: { shopId, prizeItemId },
      orderBy: { receivedAt: "asc" },
      select: { qtyRemaining: true },
    });
    expect(batches.map((b) => b.qtyRemaining)).toEqual([2, 5]);
  });
});

describe("opname commit — positive variance (§15.8)", () => {
  it("creates an adjustment batch at the weighted-average cost", async () => {
    // 5 @ 1000 and 5 @ 3000 → weighted average is 2000.
    const { shopId, prizeItemId, ownerActor } = await fixture([
      { qty: 5, unitCogs: 1000 },
      { qty: 5, unitCogs: 3000 },
    ]);
    const session = await track(startOpname(ownerActor, { shopId }));

    // Found 4 more than the system knew about.
    await saveOpnameLines(ownerActor, session.id, {
      lines: [{ prizeItemId, countedQty: 14 }],
    });
    await commitOpname(ownerActor, session.id, BUSINESS_DATE);

    const adjustment = await prisma.prizeBatch.findFirst({
      where: { shopId, prizeItemId, isAdjustment: true },
      select: { qtyReceived: true, qtyRemaining: true, unitCogs: true },
    });

    expect(adjustment?.qtyReceived).toBe(4);
    expect(adjustment?.qtyRemaining).toBe(4);
    // The weighted average, NOT zero and NOT the newest batch's cost.
    expect(adjustment?.unitCogs.toNumber()).toBe(2000);

    const movement = await prisma.stockMovement.findFirst({
      where: { shopId, prizeItemId },
      select: { type: true, qtyDelta: true },
    });
    expect(movement?.type).toBe("OPNAME_GAIN");
    expect(movement?.qtyDelta).toBe(4);
  });

  it("does not jump the FIFO queue ahead of existing stock", async () => {
    const { shopId, prizeItemId, ownerActor } = await fixture([
      { qty: 5, unitCogs: 1000 },
    ]);
    const session = await track(startOpname(ownerActor, { shopId }));
    await saveOpnameLines(ownerActor, session.id, {
      lines: [{ prizeItemId, countedQty: 8 }],
    });
    await commitOpname(ownerActor, session.id, BUSINESS_DATE);

    // Found stock takes today's date, so the genuinely older batch is still
    // consumed first.
    const batches = await prisma.prizeBatch.findMany({
      where: { shopId, prizeItemId },
      orderBy: { receivedAt: "asc" },
      select: { isAdjustment: true },
    });
    expect(batches.map((b) => b.isAdjustment)).toEqual([false, true]);
  });
});

describe("opname commit — guards", () => {
  it("refuses to commit the same session twice", async () => {
    const { shopId, prizeItemId, ownerActor } = await fixture([
      { qty: 10, unitCogs: 1000 },
    ]);
    const session = await track(startOpname(ownerActor, { shopId }));
    await saveOpnameLines(ownerActor, session.id, {
      lines: [{ prizeItemId, countedQty: 8 }],
    });
    await commitOpname(ownerActor, session.id, BUSINESS_DATE);

    await expect(
      commitOpname(ownerActor, session.id, BUSINESS_DATE),
    ).rejects.toThrow(/already been committed/i);

    // The second attempt did not consume another 2 units.
    const batches = await prisma.prizeBatch.findMany({
      where: { shopId, prizeItemId },
      select: { qtyRemaining: true },
    });
    expect(batches.reduce((s, b) => s + b.qtyRemaining, 0)).toBe(8);
  });

  it("refuses to change a count after it is committed", async () => {
    const { shopId, prizeItemId, ownerActor } = await fixture([
      { qty: 10, unitCogs: 1000 },
    ]);
    const session = await track(startOpname(ownerActor, { shopId }));
    await saveOpnameLines(ownerActor, session.id, {
      lines: [{ prizeItemId, countedQty: 10 }],
    });
    await commitOpname(ownerActor, session.id, BUSINESS_DATE);

    await expect(
      saveOpnameLines(ownerActor, session.id, {
        lines: [{ prizeItemId, countedQty: 3 }],
      }),
    ).rejects.toThrow(/already been committed/i);
  });

  it("refuses a shop the actor is not assigned to", async () => {
    const { shopId, ownerActor } = await fixture([{ qty: 5, unitCogs: 1000 }]);
    const outsider = {
      ...ownerActor,
      isOwner: false,
      shopRoles: new Map(),
    } as Actor;

    await expect(startOpname(outsider, { shopId })).rejects.toThrow();
  });
});

describe("opname variance value is owner-only (§4.11)", () => {
  it("gives the owner a variance value and the manager only a quantity", async () => {
    const { shopId, prizeItemId, ownerActor, managerActor } = await fixture([
      { qty: 10, unitCogs: 2500 },
    ]);
    const session = await track(startOpname(ownerActor, { shopId }));
    await saveOpnameLines(ownerActor, session.id, {
      lines: [{ prizeItemId, countedQty: 6 }],
    });

    const asOwner = await getOpname(ownerActor, session.id);
    const asManager = await getOpname(managerActor, session.id);

    const [ownerLine] = asOwner.lines;
    const [managerLine] = asManager.lines;

    // Both see the quantity variance...
    expect(ownerLine?.variance).toBe(-4);
    expect(managerLine?.variance).toBe(-4);

    // ...but only the owner sees what it is worth.
    expect(ownerLine).toHaveProperty("varianceValue");
    expect(managerLine).not.toHaveProperty("varianceValue");

    // §7.5: the value must be absent from the serialized body, not nulled.
    expect(JSON.stringify(asManager)).not.toContain("varianceValue");
    expect(JSON.stringify(asManager)).not.toContain("10000");
  });
});
