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
import {
  changeWorkSession,
  resolveWorkSession,
  scheduledShopHandoff,
  setWorkSession,
  workSessionRosterMismatch,
} from "../work-session";
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
  await prisma.scheduleAssignment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.shift.deleteMany({ where: { shopId: { in: shopIds } } });
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

async function rosterToday(
  actor: Actor,
  shopId: string,
  name: string,
  startTime = "08:00",
  endTime = "16:00"
) {
  const shift = await prisma.shift.create({
    data: {
      shopId,
      name,
      startTime: new Date(`1970-01-01T${startTime}:00.000Z`),
      endTime: new Date(`1970-01-01T${endTime}:00.000Z`),
      daysOfWeek: [2], // BUSINESS_DATE is Tuesday.
    },
  });

  await prisma.scheduleAssignment.create({
    data: {
      userId: actor.userId,
      shopId,
      shiftId: shift.id,
      daysOfWeek: [2],
      effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
      createdById: actor.userId,
    },
  });
}

describe("resolveWorkSession — timetable auto-selection (§4.7)", () => {
  it("auto-selects the one branch where a multi-shop user is rostered", async () => {
    const br1 = await makeShop();
    const pik = await makeShop();
    const manager = await makeActor("MANAGER", [br1.id, pik.id]);
    await rosterToday(manager, pik.id, "PIK morning");

    const resolution = await resolveWorkSession(manager);

    expect(resolution).toMatchObject({
      needsPicker: false,
      session: { shopId: pik.id },
    });
    await expect(
      prisma.workSession.findUnique({
        where: {
          userId_businessDate: {
            userId: manager.userId,
            businessDate: BUSINESS_DATE,
          },
        },
      })
    ).resolves.toMatchObject({ shopId: pik.id });
  });

  it("keeps the picker when the timetable places them at two branches", async () => {
    const br1 = await makeShop();
    const pik = await makeShop();
    const manager = await makeActor("MANAGER", [br1.id, pik.id]);
    await rosterToday(manager, br1.id, "BR-1 morning");
    await rosterToday(manager, pik.id, "PIK afternoon");

    await expect(resolveWorkSession(manager)).resolves.toMatchObject({
      needsPicker: true,
      session: null,
    });
  });

  it("keeps the picker when an only-assigned shop has no roster", async () => {
    const br1 = await makeShop();
    const staff = await makeActor("STAFF", [br1.id]);

    await expect(resolveWorkSession(staff)).resolves.toMatchObject({
      needsPicker: true,
      session: null,
    });
  });

  it("does not change the OWNER flow", async () => {
    const owner = await makeActor("OWNER");

    await expect(resolveWorkSession(owner)).resolves.toMatchObject({
      needsPicker: true,
      session: null,
    });
  });

  it("flags a one-branch roster mismatch without overwriting a manual session", async () => {
    const br1 = await makeShop();
    const pik = await makeShop();
    const manager = await makeActor("MANAGER", [br1.id, pik.id]);
    await rosterToday(manager, br1.id, "BR-1 morning");
    const session = await setWorkSession(manager, { shopId: pik.id });
    const withSession = { ...manager, workSession: session };

    await expect(resolveWorkSession(withSession)).resolves.toMatchObject({
      needsPicker: false,
      session: { shopId: pik.id },
    });
    await expect(workSessionRosterMismatch(withSession)).resolves.toMatchObject({
      id: br1.id,
    });
    await expect(
      prisma.workSession.findUnique({
        where: {
          userId_businessDate: {
            userId: manager.userId,
            businessDate: BUSINESS_DATE,
          },
        },
      })
    ).resolves.toMatchObject({ shopId: pik.id });
  });

  it("offers an unambiguous second-branch handoff 30 minutes before its shift", async () => {
    const morning = await makeShop();
    const evening = await makeShop();
    const manager = await makeActor("MANAGER", [morning.id, evening.id]);
    await rosterToday(manager, morning.id, "Morning", "08:00", "12:00");
    await rosterToday(manager, evening.id, "Evening", "16:00", "20:00");
    const session = await setWorkSession(manager, { shopId: morning.id });
    const withSession = { ...manager, workSession: session };

    // 15:30 Jakarta, 30 minutes before the 16:00 shift.
    await expect(
      scheduledShopHandoff(withSession, new Date("2026-08-18T08:30:00.000Z"))
    ).resolves.toMatchObject({
      shopId: evening.id,
      shopName: evening.name,
      shiftName: "Evening",
      startTime: "16:00",
    });

    // One minute before the arrival window: no premature prompt.
    await expect(
      scheduledShopHandoff(withSession, new Date("2026-08-18T08:29:00.000Z"))
    ).resolves.toBeNull();
  });

  it("does not guess when two other branches are due in the same handoff window", async () => {
    const current = await makeShop();
    const first = await makeShop();
    const second = await makeShop();
    const manager = await makeActor("MANAGER", [current.id, first.id, second.id]);
    await rosterToday(manager, first.id, "First evening", "16:00", "20:00");
    await rosterToday(manager, second.id, "Second evening", "16:00", "20:00");
    const session = await setWorkSession(manager, { shopId: current.id });

    await expect(
      scheduledShopHandoff(
        { ...manager, workSession: session },
        new Date("2026-08-18T08:30:00.000Z")
      )
    ).resolves.toBeNull();
  });
});

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
