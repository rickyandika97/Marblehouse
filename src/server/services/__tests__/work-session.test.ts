/**
 * Work session shop-change (PRD §4.7; BUILD-LOG D-121).
 *
 * `changeWorkSession` writes its own transaction and calls `writeAudit`
 * directly, so — same as `shops.test.ts` — this cannot run inside
 * `withRollback`'s transaction. Real rows, cleaned up in `afterEach`.
 *
 * What is worth proving:
 *
 *  - **A non-owner is asked for a reason once they have recorded something at
 *    the old shop today.** The whole point of §4.7's rule — staff covering for
 *    each other must leave a trail.
 *  - **OWNER never is, even with prior records.** D-121: the owner moves
 *    between branches to monitor them, not to work a shift under a false shop,
 *    so the "explain why you moved" prompt is pure friction for that role.
 *    Tested with prior records specifically — a check on the empty case alone
 *    would say nothing about whether the reason path was actually skipped.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, uniq, makeActorWithUser } from "./helpers";
import { changeWorkSession, setWorkSession } from "../work-session";
import type { Actor } from "@/server/auth/context";

const shopIds: string[] = [];
const userIds: string[] = [];
const saleIds: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({
    where: { entity: "WorkSession", userId: { in: userIds } },
  });
  await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
  await prisma.workSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });

  userIds.length = 0;
  shopIds.length = 0;
  saleIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const BUSINESS_DATE = new Date("2026-08-18T00:00:00.000Z");

async function makeShop() {
  const id = uniq();
  const shop = await prisma.shop.create({
    data: { code: `WST${id}`.toUpperCase().slice(0, 10), name: `WS Test ${id}` },
  });
  shopIds.push(shop.id);
  return shop;
}

async function makeActor(
  role: "OWNER" | "MANAGER" | "STAFF",
  shopIds: string[] = [],
) {
  const actor = await makeActorWithUser(prisma as unknown as Prisma.TransactionClient, {
    role,
    shopIds,
    defaultShopId: shopIds[0] ?? null,
    businessDate: BUSINESS_DATE,
  });
  userIds.push(actor.userId);
  return actor;
}

/** Records one sale at `shopId` under `actor`, so `countRecordsToday` finds it. */
async function recordSaleToday(actor: Actor, shopId: string) {
  const sale = await prisma.sale.create({
    data: {
      shopId,
      recordedById: actor.userId,
      amount: "50000",
      paymentMethod: "CASH",
      businessDate: BUSINESS_DATE,
    },
  });
  saleIds.push(sale.id);
}

describe("changeWorkSession — reason requirement (§4.7)", () => {
  it("requires a reason for a MANAGER who already recorded a sale today", async () => {
    const shopA = await makeShop();
    const shopB = await makeShop();
    const manager = await makeActor("MANAGER", [shopA.id, shopB.id]);

    await setWorkSession(manager, { shopId: shopA.id });
    await recordSaleToday(manager, shopA.id);

    const error = await changeWorkSession(manager, { shopId: shopB.id }).catch(
      (e) => e,
    );

    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.details.recordsAtOldShop).toBe(1);

    // Refused — still at the old shop.
    const session = await prisma.workSession.findUnique({
      where: {
        userId_businessDate: { userId: manager.userId, businessDate: BUSINESS_DATE },
      },
    });
    expect(session?.shopId).toBe(shopA.id);
  });

  it("succeeds for a MANAGER once a reason is given", async () => {
    const shopA = await makeShop();
    const shopB = await makeShop();
    const manager = await makeActor("MANAGER", [shopA.id, shopB.id]);

    await setWorkSession(manager, { shopId: shopA.id });
    await recordSaleToday(manager, shopA.id);

    const result = await changeWorkSession(manager, {
      shopId: shopB.id,
      reason: "covering the evening shift at Branch 2",
    });

    expect(result.shopId).toBe(shopB.id);

    const row = await prisma.auditLog.findFirst({
      where: { entity: "WorkSession", userId: manager.userId, action: "CHANGE_SHOP" },
      orderBy: { occurredAt: "desc" },
    });
    expect(row?.reason).toBe("covering the evening shift at Branch 2");
  });

  it("does NOT require a reason for a MANAGER with no prior records today", async () => {
    const shopA = await makeShop();
    const shopB = await makeShop();
    const manager = await makeActor("MANAGER", [shopA.id, shopB.id]);

    await setWorkSession(manager, { shopId: shopA.id });

    await expect(
      changeWorkSession(manager, { shopId: shopB.id }),
    ).resolves.toMatchObject({ shopId: shopB.id });
  });

  it("never requires a reason for OWNER, even with prior records (D-121)", async () => {
    const shopA = await makeShop();
    const shopB = await makeShop();
    const owner = await makeActor("OWNER");

    await setWorkSession(owner, { shopId: shopA.id });
    await recordSaleToday(owner, shopA.id);

    // No `reason` in the input — this is the case that used to 422.
    const result = await changeWorkSession(owner, { shopId: shopB.id });

    expect(result.shopId).toBe(shopB.id);

    const row = await prisma.auditLog.findFirst({
      where: { entity: "WorkSession", userId: owner.userId, action: "CHANGE_SHOP" },
      orderBy: { occurredAt: "desc" },
    });
    expect(row).not.toBeNull();
    expect(row?.reason).toBeNull();
  });
});
