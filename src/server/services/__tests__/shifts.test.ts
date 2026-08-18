/**
 * Shift configuration (PRD §4.14, §7.7; BUILD-LOG D-105).
 *
 * `shifts.ts` shipped in Phase 6 with no unit tests — it was covered only by
 * `verify-phase6.sh`. Building the owner screen (D-105) is the first time
 * anything drives these functions directly, so the invariants get pinned now.
 *
 * What is worth proving rather than assuming:
 *
 *  - **A MANAGER may configure shifts at their own shop, and STAFF may not.**
 *    §3.4 delegates this one, unlike prices. The permission differs from every
 *    other screen in Settings → Shops, so it is the thing most likely to be
 *    "corrected" to owner-only by a later session.
 *  - **A manager is still confined to their own branches.** The delegation
 *    must not become a way to reach another shop by id.
 *  - **A shift crossing midnight is legitimate** (§4.14) and must not be
 *    validated away — a 22:00–06:00 night shift is normal.
 *  - **Delete vs deactivate.** A shift with attendance against it is retired,
 *    never removed, or historical rows stop resolving their shift name.
 *  - **Editing never rewrites past lateness.** Attendance snapshots the start
 *    time at clock-in; a typo fix must not turn punctual arrivals into late
 *    ones. This is the one that silently rewrites history if it breaks.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { prisma, uniq } from "./helpers";
import {
  createShift,
  deleteShift,
  listShifts,
  shiftSchema,
  updateShift,
} from "../shifts";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

const TEST_CODE_PREFIX = "ZSHF";
const testCode = () => `${TEST_CODE_PREFIX}${uniq().slice(0, 5)}`.toUpperCase();

const shopIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await prisma.attendance.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.shift.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  // Backstop for anything that escaped the id lists.
  await prisma.shop.deleteMany({
    where: { code: { startsWith: TEST_CODE_PREFIX } },
  });

  userIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeShop() {
  const shop = await prisma.shop.create({
    data: { code: testCode(), name: `Shift Test ${uniq()}`, timezone: "Asia/Jakarta" },
  });
  shopIds.push(shop.id);
  return shop;
}

async function makeUser(
  role: Actor["role"],
  assignedShopIds: string[],
): Promise<Actor> {
  const id = uniq();
  const user = await prisma.user.create({
    data: {
      email: `shf-${id}@marblehouse.invalid`,
      name: `Shf ${id}`,
      username: `shf-${id}`,
      displayName: `Shf ${id}`,
      role,
    },
    select: { id: true, displayName: true, username: true },
  });
  userIds.push(user.id);

  for (const shopId of assignedShopIds) {
    await prisma.userShop.create({ data: { userId: user.id, shopId } });
  }

  return {
    sessionId: `sess-${id}`,
    userId: user.id,
    username: user.username ?? id,
    displayName: user.displayName,
    role,
    isActive: true,
    mustChangePassword: false,
    canEnterCost: false,
    defaultShopId: assignedShopIds[0] ?? null,
    assignedShopIds,
    businessDate: new Date("2026-08-18T00:00:00.000Z"),
    workSession: null,
  } as unknown as Actor;
}

// ─────────────────────────── permissions (§3.4) ───────────────────────────

describe("who may configure shifts", () => {
  it("lets a MANAGER manage shifts at their OWN shop", async () => {
    const shop = await makeShop();
    const manager = await makeUser("MANAGER", [shop.id]);

    // Unlike sale prices, this is delegated (§3.4). A manager held to a
    // lateness rule can set the shift it is measured from.
    const shift = await createShift(manager, shop.id, {
      name: "Morning",
      startTime: "10:00",
      endTime: "18:00",
    });
    expect(shift.name).toBe("Morning");

    const renamed = await updateShift(manager, shift.id, { name: "Early" });
    expect(renamed.name).toBe("Early");

    await expect(deleteShift(manager, shift.id)).resolves.toMatchObject({
      deleted: true,
    });
  });

  it("refuses STAFF outright", async () => {
    const shop = await makeShop();
    const staff = await makeUser("STAFF", [shop.id]);
    const owner = await makeUser("OWNER", []);
    const shift = await createShift(owner, shop.id, {
      name: "Morning",
      startTime: "10:00",
      endTime: "18:00",
    });

    for (const call of [
      () => createShift(staff, shop.id, { name: "X", startTime: "09:00", endTime: "17:00" }),
      () => updateShift(staff, shift.id, { name: "X" }),
      () => deleteShift(staff, shift.id),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("FORBIDDEN");
    }

    // Staff CAN read them — the clock-in screen needs the list.
    await expect(listShifts(staff, shop.id)).resolves.toHaveLength(1);

    // And nothing they attempted took effect.
    const after = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(after.name).toBe("Morning");
  });

  it("confines a MANAGER to their own branches", async () => {
    const mine = await makeShop();
    const theirs = await makeShop();
    const manager = await makeUser("MANAGER", [mine.id]);
    const owner = await makeUser("OWNER", []);

    const foreign = await createShift(owner, theirs.id, {
      name: "Theirs",
      startTime: "10:00",
      endTime: "18:00",
    });

    // Delegation must not become a way to reach another branch by id.
    for (const call of [
      () => createShift(manager, theirs.id, { name: "X", startTime: "09:00", endTime: "17:00" }),
      () => updateShift(manager, foreign.id, { name: "Hijacked" }),
      () => deleteShift(manager, foreign.id),
      () => listShifts(manager, theirs.id),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("FORBIDDEN");
    }

    const untouched = await prisma.shift.findUniqueOrThrow({
      where: { id: foreign.id },
    });
    expect(untouched.name).toBe("Theirs");
  });

  it("lets an OWNER manage any branch with no assignment", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);

    await expect(
      createShift(owner, shop.id, {
        name: "Morning",
        startTime: "10:00",
        endTime: "18:00",
      }),
    ).resolves.toMatchObject({ name: "Morning" });
  });
});

// ──────────────────────── times, days and midnight ────────────────────────

describe("shift times", () => {
  it("accepts a shift that crosses midnight (§4.14)", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);

    // A 22:00–06:00 night shift is normal for a late-closing branch and must
    // not be validated away.
    const shift = await createShift(owner, shop.id, {
      name: "Night",
      startTime: "22:00",
      endTime: "06:00",
    });

    expect(shift.startTime).toBe("22:00");
    expect(shift.endTime).toBe("06:00");
    // Flagged so the UI can label it rather than showing what looks like an error.
    expect(shift.crossesMidnight).toBe(true);
  });

  it("refuses a shift that starts and ends at the same time", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);

    const error = await createShift(owner, shop.id, {
      name: "Nothing",
      startTime: "10:00",
      endTime: "10:00",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses the same-time case on an EDIT too, not only on create", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const shift = await createShift(owner, shop.id, {
      name: "Morning",
      startTime: "10:00",
      endTime: "18:00",
    });

    // Only the END moves, so the check has to combine it with the STORED
    // start — testing one field says nothing about the other (D-34).
    const error = await updateShift(owner, shift.id, { endTime: "10:00" }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");

    const unchanged = await prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
    expect(unchanged.endTime.getUTCHours()).toBe(18);
  });

  it("rejects malformed and out-of-range times at the schema", async () => {
    for (const t of ["24:00", "9:00", "10:60", "1000", "", "10:00:00"]) {
      const parsed = shiftSchema.safeParse({
        name: "X",
        startTime: t,
        endTime: "18:00",
      });
      expect(parsed.success, `"${t}" must be rejected`).toBe(false);
    }
  });

  it("defaults to every day, and stores a chosen subset", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);

    const everyDay = await createShift(owner, shop.id, {
      name: "Daily",
      startTime: "10:00",
      endTime: "18:00",
    });
    expect(everyDay.daysOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);

    const weekdays = await createShift(owner, shop.id, {
      name: "Weekdays",
      startTime: "09:00",
      endTime: "17:00",
      daysOfWeek: [1, 2, 3, 4, 5],
    });
    expect(weekdays.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it("rejects an empty or out-of-range day list", async () => {
    for (const days of [[], [7], [-1]]) {
      const parsed = shiftSchema.safeParse({
        name: "X",
        startTime: "10:00",
        endTime: "18:00",
        daysOfWeek: days,
      });
      expect(parsed.success, `${JSON.stringify(days)} must be rejected`).toBe(false);
    }
  });
});

// ──────────────────── removal: delete vs deactivate ────────────────────

describe("removing a shift", () => {
  /** An attendance row against a shift, so the "used" branch is genuine. */
  async function attend(shopId: string, shiftId: string, userId: string) {
    return prisma.attendance.create({
      data: {
        userId,
        shopId,
        shiftId,
        businessDate: new Date("2026-08-18T00:00:00.000Z"),
        clockInAt: new Date("2026-08-18T03:00:00.000Z"),
        photoPath: "test/none.jpg",
      },
    });
  }

  it("deletes outright when no attendance references it", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const shift = await createShift(owner, shop.id, {
      name: "Mistake",
      startTime: "10:00",
      endTime: "18:00",
    });

    await expect(deleteShift(owner, shift.id)).resolves.toMatchObject({
      deleted: true,
      deactivated: false,
    });
    await expect(
      prisma.shift.findUnique({ where: { id: shift.id } }),
    ).resolves.toBeNull();
  });

  it("DEACTIVATES instead when attendance references it", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const shift = await createShift(owner, shop.id, {
      name: "Morning",
      startTime: "10:00",
      endTime: "18:00",
    });
    const row = await attend(shop.id, shift.id, owner.userId);

    await expect(deleteShift(owner, shift.id)).resolves.toMatchObject({
      deactivated: true,
      deleted: false,
    });

    // THE POINT: the row survives, so the historical attendance can still
    // resolve its shift name.
    const still = await prisma.shift.findUnique({ where: { id: shift.id } });
    expect(still).not.toBeNull();
    expect(still!.isActive).toBe(false);

    const attendance = await prisma.attendance.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(attendance.shiftId).toBe(shift.id);
  });

  it("hides a retired shift from the active list but keeps it readable", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const shift = await createShift(owner, shop.id, {
      name: "Morning",
      startTime: "10:00",
      endTime: "18:00",
    });
    await attend(shop.id, shift.id, owner.userId);
    await deleteShift(owner, shift.id);

    // listShifts returns everything for the admin screen, marked.
    const all = await listShifts(owner, shop.id);
    expect(all.find((s) => s.id === shift.id)?.isActive).toBe(false);
  });
});

// ──────────────── the invariant that rewrites history if broken ────────────────

describe("§4.14 — editing a shift never rewrites past lateness", () => {
  it("leaves an existing attendance row's snapshot untouched", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const shift = await createShift(owner, shop.id, {
      name: "Morning",
      startTime: "10:00",
      endTime: "18:00",
    });

    // Someone clocked in at 10:02 against a 10:00 start with 5 min grace:
    // punctual, and the row snapshots the start it was judged against.
    const row = await prisma.attendance.create({
      data: {
        userId: owner.userId,
        shopId: shop.id,
        shiftId: shift.id,
        businessDate: new Date("2026-08-18T00:00:00.000Z"),
        clockInAt: new Date("2026-08-18T03:02:00.000Z"),
        shiftStartAtCapture: new Date(Date.UTC(1970, 0, 1, 10, 0, 0)),
        graceMinAtCapture: 5,
        status: "PRESENT",
        isLate: false,
        lateMinutes: 0,
        photoPath: "test/none.jpg",
      },
    });

    // The owner corrects the shift to start an hour earlier.
    await updateShift(owner, shift.id, { startTime: "09:00" });

    const after = await prisma.attendance.findUniqueOrThrow({
      where: { id: row.id },
    });

    // That arrival must NOT become 62 minutes late in hindsight.
    expect(after.isLate).toBe(false);
    expect(after.lateMinutes).toBe(0);
    expect(after.status).toBe("PRESENT");
    expect(after.shiftStartAtCapture?.getUTCHours()).toBe(10);
    expect(after.graceMinAtCapture).toBe(5);
  });
});
