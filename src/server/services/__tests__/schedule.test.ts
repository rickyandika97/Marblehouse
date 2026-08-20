/**
 * The staff timetable (PRD §4.14.1; BUILD-LOG D-136).
 *
 * What is worth proving rather than assuming:
 *
 *  - **The resolver composes pattern + overrides correctly.** This is the whole
 *    feature. Every screen and the clock-in gate read `resolveDay`; if it is
 *    wrong, the roster is wrong everywhere at once and nobody can tell from a
 *    single screen.
 *  - **`REMOVED` is per-shift, not per-day.** Removing someone from the morning
 *    leaves them on the evening. Getting this wrong silently wipes a person off
 *    a day they are still expected to work.
 *  - **An override never mutates the pattern.** "Change next Tuesday" must not
 *    change every Tuesday — the failure mode that destroys a published roster.
 *  - **An assignment cannot exceed its shift's operating days.** Otherwise the
 *    roster shows staff on days the branch is shut.
 *  - **A MANAGER may roster their own shop and only their own**, matching
 *    `shifts.ts` (§3.4), and STAFF may not roster at all.
 *  - **Unscheduled clock-in is allowed but demands a reason** (§4.14.1). The
 *    permission-shaped mistake here is to BLOCK it: a branch that cannot open
 *    because the roster is stale is worse than an unexplained attendance row.
 *  - **Ending an assignment preserves history.** A pattern that governed real
 *    days is closed, not deleted, or "was Budi scheduled that day?" becomes
 *    unanswerable for every past date.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, uniq, makeActorWithUser } from "./helpers";
import {
  createAssignment,
  createOverride,
  deleteOverride,
  removeAssignment,
  restoreAssignment,
  createLeave,
  cancelLeave,
  listLeave,
  leaveFor,
  leaveSchema,
  listAssignments,
  overrideSchema,
  myScheduleToday,
  resolveDay,
  resolveWeek,
  updateAssignment,
} from "../schedule";
import { createShift } from "../shifts";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

const TEST_CODE_PREFIX = "ZSCH";
const testCode = () => `${TEST_CODE_PREFIX}${uniq().slice(0, 5)}`.toUpperCase();

/**
 * A Thursday. Fixed rather than "today" so the weekday arithmetic is a fact of
 * the test, not of the day it happens to run — a suite that only passes on a
 * weekday is a suite that fails on a Sunday for no reason.
 */
const THURSDAY = new Date("2026-09-03T00:00:00.000Z");
const FRIDAY = new Date("2026-09-04T00:00:00.000Z");
const SUNDAY = new Date("2026-09-06T00:00:00.000Z");
const MONDAY = new Date("2026-09-07T00:00:00.000Z");

const SUN = 0, MON = 1, TUE = 2, WED = 3, THU = 4, FRI = 5, SAT = 6;
const ALL_DAYS = [SUN, MON, TUE, WED, THU, FRI, SAT];

const shopIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await prisma.scheduleLeave.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.scheduleOverride.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.scheduleAssignment.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.attendance.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.shift.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  await prisma.shop.deleteMany({
    where: { code: { startsWith: TEST_CODE_PREFIX } },
  });

  userIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeShop(name = "Schedule Test") {
  const shop = await prisma.shop.create({
    data: { code: testCode(), name: `${name} ${uniq()}`, timezone: "Asia/Jakarta" },
  });
  shopIds.push(shop.id);
  return shop;
}

async function makeUser(
  role: "OWNER" | "MANAGER" | "STAFF",
  assigned: string[],
  businessDate: Date = THURSDAY
): Promise<Actor> {
  const actor = await makeActorWithUser(
    prisma as unknown as Prisma.TransactionClient,
    {
      role,
      shopIds: assigned,
      defaultShopId: assigned[0] ?? null,
      businessDate,
    }
  );
  userIds.push(actor.userId);
  return actor;
}

/** A shift running every day unless told otherwise. */
async function makeShift(
  owner: Actor,
  shopId: string,
  name: string,
  startTime: string,
  endTime: string,
  daysOfWeek: number[] = ALL_DAYS
) {
  return createShift(owner, shopId, { name, startTime, endTime, daysOfWeek });
}

// ─────────────────────────── permissions (§3.4) ───────────────────────────

describe("who may change the timetable", () => {
  it("lets a MANAGER roster at their OWN shop", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const manager = await makeUser("MANAGER", [shop.id]);
    const staff = await makeUser("STAFF", [shop.id]);

    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    // Delegated, exactly as shift configuration is (§3.4). A manager who runs
    // the branch rosters the branch.
    const created = await createAssignment(manager, shop.id, {
      userId: staff.userId,
      shiftId: shift.id,
      daysOfWeek: [MON, TUE, WED],
      effectiveFrom: "2026-09-01",
    });

    expect(created.id).toBeTruthy();
  });

  it("refuses STAFF outright", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const staff = await makeUser("STAFF", [shop.id]);
    const other = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    // A staff member rostering themselves would make the timetable meaningless
    // as a control.
    await expect(
      createAssignment(staff, shop.id, {
        userId: other.userId,
        shiftId: shift.id,
        daysOfWeek: [MON],
        effectiveFrom: "2026-09-01",
      })
    ).rejects.toThrow(AppError);
  });

  it("confines a MANAGER to their own branches", async () => {
    const mine = await makeShop("Mine");
    const theirs = await makeShop("Theirs");
    const owner = await makeUser("OWNER", []);
    const manager = await makeUser("MANAGER", [mine.id]);
    const staff = await makeUser("STAFF", [theirs.id]);

    const shift = await makeShift(owner, theirs.id, "Morning", "08:00", "12:00");

    // Passing another branch's id directly is the obvious attempt.
    await expect(
      createAssignment(manager, theirs.id, {
        userId: staff.userId,
        shiftId: shift.id,
        daysOfWeek: [MON],
        effectiveFrom: "2026-09-01",
      })
    ).rejects.toThrow(AppError);
  });

  it("lets an OWNER roster any branch with no assignment", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const staff = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await expect(
      createAssignment(owner, shop.id, {
        userId: staff.userId,
        shiftId: shift.id,
        daysOfWeek: [MON],
        effectiveFrom: "2026-09-01",
      })
    ).resolves.toMatchObject({ id: expect.any(String) });
  });
});

// ─────────────────────────── rosterability ───────────────────────────

describe("who may be rostered", () => {
  it("refuses someone not assigned to the branch", async () => {
    const shop = await makeShop();
    const elsewhere = await makeShop("Elsewhere");
    const owner = await makeUser("OWNER", []);
    const stranger = await makeUser("STAFF", [elsewhere.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    // A roster that looks staffed and a person who 403s on arrival is worse
    // than an empty cell — nobody goes looking for it.
    await expect(
      createAssignment(owner, shop.id, {
        userId: stranger.userId,
        shiftId: shift.id,
        daysOfWeek: [MON],
        effectiveFrom: "2026-09-01",
      })
    ).rejects.toThrow(/not assigned to this branch/i);
  });

  it("refuses a deactivated employee", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const staff = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await prisma.user.update({
      where: { id: staff.userId },
      data: { banned: true },
    });

    await expect(
      createAssignment(owner, shop.id, {
        userId: staff.userId,
        shiftId: shift.id,
        daysOfWeek: [MON],
        effectiveFrom: "2026-09-01",
      })
    ).rejects.toThrow(/deactivated/i);
  });

  it("refuses a shift belonging to a different branch", async () => {
    const shop = await makeShop();
    const other = await makeShop("Other");
    const owner = await makeUser("OWNER", []);
    const staff = await makeUser("STAFF", [shop.id]);

    const foreignShift = await makeShift(owner, other.id, "Morning", "08:00", "12:00");

    await expect(
      createAssignment(owner, shop.id, {
        userId: staff.userId,
        shiftId: foreignShift.id,
        daysOfWeek: [MON],
        effectiveFrom: "2026-09-01",
      })
    ).rejects.toThrow(/not available at this branch/i);
  });
});

// ──────────────────── the assignment ⊆ shift rule ────────────────────

describe("an assignment selects from within its shift's days", () => {
  it("refuses a day the shift does not run", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const staff = await makeUser("STAFF", [shop.id]);

    // The branch runs this shift Mon-Wed only.
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00", [
      MON,
      TUE,
      WED,
    ]);

    // Rostering Budi on Sunday would put a name on the timetable for a day
    // nobody is there. The shift is the shop's operating reality.
    await expect(
      createAssignment(owner, shop.id, {
        userId: staff.userId,
        shiftId: shift.id,
        daysOfWeek: [MON, SUN],
        effectiveFrom: "2026-09-01",
      })
    ).rejects.toThrow(/does not run on Sunday/i);
  });

  it("applies the same rule on an EDIT, not only on create", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const staff = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00", [
      MON,
      TUE,
      WED,
    ]);

    const a = await createAssignment(owner, shop.id, {
      userId: staff.userId,
      shiftId: shift.id,
      daysOfWeek: [MON],
      effectiveFrom: "2026-09-01",
    });

    // D-34's lesson: one branch passing says nothing about the other.
    await expect(
      updateAssignment(owner, a.id, { daysOfWeek: [MON, SAT] })
    ).rejects.toThrow(/does not run on Saturday/i);
  });

  it("accepts a subset of the shift's days", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const staff = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: staff.userId,
      shiftId: shift.id,
      daysOfWeek: [WED, MON, TUE],
      effectiveFrom: "2026-09-01",
    });

    const [row] = await listAssignments(owner, shop.id);
    expect(row?.id).toBe(a.id);
    // Stored sorted, so the UI never has to.
    expect(row?.daysOfWeek).toEqual([MON, TUE, WED]);
  });
});

// ─────────────────────────── the resolver ───────────────────────────

describe("resolveDay composes the pattern with overrides", () => {
  it("places a person on the days their pattern names, and no others", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    // Mon-Wed only. Thursday must be empty.
    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: [MON, TUE, WED],
      effectiveFrom: "2026-09-01",
    });

    expect(await resolveDay(owner, shop.id, MONDAY)).toHaveLength(1);
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
  });

  it("respects effectiveFrom — nothing before the pattern started", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    // Starts the Friday. The Thursday before must be empty even though the
    // weekday matches — a schedule does not claim to have always been true.
    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-04",
    });

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
    expect(await resolveDay(owner, shop.id, FRIDAY)).toHaveLength(1);
    expect(await resolveDay(owner, shop.id, SUNDAY)).toHaveLength(1);
  });

  it("defaults effectiveFrom to today when the caller omits it (D-140)", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    // The roster form does not ask for a start date. The actor's business date
    // is THURSDAY 2026-09-03.
    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
    });

    const [row] = await listAssignments(owner, shop.id);
    expect(row?.effectiveFrom).toBe("2026-09-03");
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);
  });

  it("adds someone with an ADDED override on a day the pattern excludes", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const ricky = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    // No pattern at all for Ricky — he is covering.
    await createOverride(owner, shop.id, {
      userId: ricky.userId,
      shiftId: shift.id,
      businessDate: "2026-09-03",
      kind: "ADDED",
      reason: "Covering for Budi",
    });

    const day = await resolveDay(owner, shop.id, THURSDAY);
    expect(day).toHaveLength(1);
    expect(day[0]).toMatchObject({
      userId: ricky.userId,
      via: "OVERRIDE",
      reason: "Covering for Budi",
    });
  });

  it("removes someone with a REMOVED override on a day the pattern includes", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);

    await createOverride(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      businessDate: "2026-09-03",
      kind: "REMOVED",
      reason: "Annual leave",
    });

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
    // The pattern is untouched: only that ONE date changed.
    expect(await resolveDay(owner, shop.id, FRIDAY)).toHaveLength(1);
  });

  it("keeps REMOVED per-shift: off the morning is still on the evening", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);

    const morning = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");
    const evening = await makeShift(owner, shop.id, "Evening", "12:00", "18:00");

    for (const shift of [morning, evening]) {
      await createAssignment(owner, shop.id, {
        userId: budi.userId,
        shiftId: shift.id,
        daysOfWeek: ALL_DAYS,
        effectiveFrom: "2026-09-01",
      });
    }

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(2);

    // Off the morning only. A day's leave is TWO override rows, which is
    // precisely why the unique key includes shiftId.
    await createOverride(owner, shop.id, {
      userId: budi.userId,
      shiftId: morning.id,
      businessDate: "2026-09-03",
      kind: "REMOVED",
      reason: "Doctor's appointment",
    });

    const day = await resolveDay(owner, shop.id, THURSDAY);
    expect(day).toHaveLength(1);
    expect(day[0]?.shiftId).toBe(evening.id);
  });

  it("does not roster a deactivated employee even with a live pattern", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    // Someone who has left keeps their pattern rows (history), but must stop
    // appearing on the roster the moment they are deactivated.
    await prisma.user.update({
      where: { id: budi.userId },
      data: { banned: true },
    });

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
  });

  it("drops the roster when the SHIFT is retired, without touching the pattern", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await prisma.shift.update({
      where: { id: shift.id },
      data: { isActive: false },
    });

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
  });

  it("stops rostering a day the SHIFT stopped running, even for an older pattern", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: [THU, FRI],
      effectiveFrom: "2026-09-01",
    });
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);

    // The branch stops opening Thursdays. The assignment still says THU — the
    // resolver must intersect, not trust the older row.
    await prisma.shift.update({
      where: { id: shift.id },
      data: { daysOfWeek: [FRI] },
    });

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
    expect(await resolveDay(owner, shop.id, FRIDAY)).toHaveLength(1);
  });
});

// ─────────────── overrides never mutate the pattern ───────────────

describe("§4.14.1 — an override changes one date, never the pattern", () => {
  it("leaves every other matching weekday untouched", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await createOverride(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      businessDate: "2026-09-03",
      kind: "REMOVED",
      reason: "Leave",
    });

    // The stored pattern is byte-for-byte what it was. This is the check that
    // fails if someone ever "simplifies" overrides into an assignment edit.
    const stored = await prisma.scheduleAssignment.findUnique({
      where: { id: a.id },
      select: { daysOfWeek: true, effectiveFrom: true, removedAt: true },
    });
    expect([...(stored?.daysOfWeek ?? [])].sort()).toEqual(ALL_DAYS);
    expect(stored?.removedAt).toBeNull();

    // And the following Thursday is still rostered.
    const nextThursday = new Date("2026-09-10T00:00:00.000Z");
    expect(await resolveDay(owner, shop.id, nextThursday)).toHaveLength(1);
  });

  it("replaces rather than stacks when the same slot is decided twice", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await createOverride(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      businessDate: "2026-09-03",
      kind: "REMOVED",
      reason: "Leave",
    });
    // Changed their mind — leave cancelled.
    await createOverride(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      businessDate: "2026-09-03",
      kind: "ADDED",
      reason: "Leave cancelled",
    });

    const rows = await prisma.scheduleOverride.count({
      where: { userId: budi.userId, shiftId: shift.id },
    });
    expect(rows).toBe(1);
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);
  });

  it("restores the pattern when an override is deleted", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    const o = await createOverride(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      businessDate: "2026-09-03",
      kind: "REMOVED",
      reason: "Leave",
    });
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);

    await deleteOverride(owner, o.id);
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);
  });

  it("demands a real reason", () => {
    // "Why was the roster different that week?" is the question this row exists
    // to answer; whitespace cannot answer it. Checked at the schema, which is
    // where the route validates before the service is ever reached.
    const blank = overrideSchema.safeParse({
      userId: "u1",
      shiftId: "s1",
      businessDate: "2026-09-03",
      kind: "REMOVED",
      reason: "   ",
    });
    expect(blank.success).toBe(false);

    const given = overrideSchema.safeParse({
      userId: "u1",
      shiftId: "s1",
      businessDate: "2026-09-03",
      kind: "REMOVED",
      reason: "Annual leave",
    });
    expect(given.success).toBe(true);
  });
});

// ─────────────────────────── ending an assignment ───────────────────────────

describe("myScheduleToday drives the clock-in prompt", () => {
  it("reports scheduled with the shift, on a day the pattern names", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id], THURSDAY);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: [THU],
      effectiveFrom: "2026-09-01",
    });

    const mine = await myScheduleToday(budi, shop.id);
    expect(mine.scheduled).toBe(true);
    expect(mine.slots).toHaveLength(1);
    expect(mine.slots[0]).toMatchObject({
      shiftId: shift.id,
      shiftName: "Morning",
      startTime: "08:00",
      endTime: "12:00",
    });
  });

  it("reports NOT scheduled on the person's day off", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    // Business date is a Sunday; the pattern is Mon-Wed.
    const budi = await makeUser("STAFF", [shop.id], SUNDAY);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: [MON, TUE, WED],
      effectiveFrom: "2026-09-01",
    });

    // This is the whole point of the feature: no nagging on a day off.
    const mine = await myScheduleToday(budi, shop.id);
    expect(mine.scheduled).toBe(false);
    expect(mine.slots).toHaveLength(0);
  });

  it("shows only MY slots, not the whole branch's", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id], THURSDAY);
    const alvin = await makeUser("STAFF", [shop.id], THURSDAY);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    for (const u of [budi, alvin]) {
      await createAssignment(owner, shop.id, {
        userId: u.userId,
        shiftId: shift.id,
        daysOfWeek: ALL_DAYS,
        effectiveFrom: "2026-09-01",
      });
    }

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(2);
    const mine = await myScheduleToday(budi, shop.id);
    expect(mine.slots).toHaveLength(1);
  });

  it("counts an ADDED override as scheduled", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const ricky = await makeUser("STAFF", [shop.id], THURSDAY);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    // Rostered by a manager for that date only. He IS expected today, so the
    // prompt should greet him rather than treat him as an intruder.
    await createOverride(owner, shop.id, {
      userId: ricky.userId,
      shiftId: shift.id,
      businessDate: "2026-09-03",
      kind: "ADDED",
      reason: "Covering for Budi",
    });

    const mine = await myScheduleToday(ricky, shop.id);
    expect(mine.scheduled).toBe(true);
    expect(mine.slots[0]).toMatchObject({ via: "OVERRIDE" });
  });
});

// ─────────────────────────── the week grid ───────────────────────────

describe("resolveWeek", () => {
  it("returns seven consecutive days starting where asked", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: [MON, WED, FRI],
      effectiveFrom: "2026-09-01",
    });

    // Monday 7 Sep 2026 through Sunday 13 Sep — a full week inside the
    // assignment's effective range, so the only thing filtering days is the
    // pattern itself.
    const week = await resolveWeek(owner, shop.id, "2026-09-07");
    expect(week.days).toHaveLength(7);
    expect(week.days[0]?.businessDate).toBe("2026-09-07");
    expect(week.days[6]?.businessDate).toBe("2026-09-13");

    const staffed = week.days.filter((d) => d.slots.length > 0);
    expect(staffed.map((d) => d.weekday)).toEqual([MON, WED, FRI]);
  });
});

describe("editing a saved schedule", () => {
  it("changes the days without disturbing the start date", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: [MON, TUE, WED],
      effectiveFrom: "2026-09-01",
    });

    await updateAssignment(owner, a.id, { daysOfWeek: [THU, FRI, SAT] });

    const [row] = await listAssignments(owner, shop.id);
    expect(row?.daysOfWeek).toEqual([THU, FRI, SAT]);
    expect(row?.effectiveFrom).toBe("2026-09-01");
    expect(row?.isRemoved).toBe(false);
  });

  it("refuses an edit from a MANAGER at a different branch", async () => {
    const mine = await makeShop("Mine");
    const theirs = await makeShop("Theirs");
    const owner = await makeUser("OWNER", []);
    const manager = await makeUser("MANAGER", [mine.id]);
    const budi = await makeUser("STAFF", [theirs.id]);
    const shift = await makeShift(owner, theirs.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, theirs.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await expect(
      updateAssignment(manager, a.id, { daysOfWeek: [MON] })
    ).rejects.toThrow(AppError);
  });
});

// ─────────────────── Remove: hide, but keep the record ───────────────────

describe("removing a schedule (§4.14.1, D-140)", () => {
  /**
   * The owner's requirement, in their words: *"hide it, i want the data to stay
   * intact like all the record of late etc, i just dont want the clutter."*
   *
   * So Remove is a SOFT delete. The row leaves the roster and stops rostering
   * anyone, but it survives — because an attendance row reading
   * `SCHEDULED, 440 minutes late` only means something while the schedule that
   * put that person on a 10:00 shift still exists to be read.
   */
  it("takes the person off the roster", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);

    await removeAssignment(owner, a.id);

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
  });

  it("KEEPS the row in the database, so past records stay explicable", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await removeAssignment(owner, a.id);

    // This is the whole owner requirement. A hard delete would pass every other
    // test in this file and lose the evidence behind every lateness claim.
    const stored = await prisma.scheduleAssignment.findUnique({
      where: { id: a.id },
      select: { id: true, removedAt: true, daysOfWeek: true },
    });
    expect(stored).not.toBeNull();
    expect(stored?.removedAt).not.toBeNull();
    expect([...(stored?.daysOfWeek ?? [])].sort()).toEqual(ALL_DAYS);
  });

  it("hides it from the roster list but keeps it readable on request", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });
    await removeAssignment(owner, a.id);

    // No clutter by default — the point of the button.
    expect(await listAssignments(owner, shop.id)).toHaveLength(0);

    const withRemoved = await listAssignments(owner, shop.id, {
      includeRemoved: true,
    });
    expect(withRemoved).toHaveLength(1);
    expect(withRemoved[0]?.isRemoved).toBe(true);
  });

  it("can be restored after a mis-tap", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await removeAssignment(owner, a.id);
    await restoreAssignment(owner, a.id);

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);
    expect((await listAssignments(owner, shop.id))[0]?.isRemoved).toBe(false);
  });

  it("refuses to restore onto a retired shift", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });
    await removeAssignment(owner, a.id);
    await prisma.shift.update({
      where: { id: shift.id },
      data: { isActive: false },
    });

    await expect(restoreAssignment(owner, a.id)).rejects.toThrow(/retired/i);
  });

  it("refuses a double removal, and a restore of something live", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await expect(restoreAssignment(owner, a.id)).rejects.toThrow(/not removed/i);
    await removeAssignment(owner, a.id);
    await expect(removeAssignment(owner, a.id)).rejects.toThrow(/already/i);
  });

  it("confines a MANAGER to their own branch", async () => {
    const mine = await makeShop("Mine");
    const theirs = await makeShop("Theirs");
    const owner = await makeUser("OWNER", []);
    const manager = await makeUser("MANAGER", [mine.id]);
    const budi = await makeUser("STAFF", [theirs.id]);
    const shift = await makeShift(owner, theirs.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, theirs.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await expect(removeAssignment(manager, a.id)).rejects.toThrow(AppError);
  });
});

// ─────────────────────────── Leave ───────────────────────────

describe("leave (§4.14.2, D-140)", () => {
  it("takes the person off the roster for the whole range, and no longer", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    // Thu 3rd to Sat 5th. Sunday the 6th is back at work.
    await createLeave(owner, {
      userId: budi.userId,
      startDate: "2026-09-03",
      endDate: "2026-09-05",
      reason: "Annual leave",
    });

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
    expect(await resolveDay(owner, shop.id, FRIDAY)).toHaveLength(0);
    // The whole point of a range: it ends by itself, with nothing to switch on.
    expect(await resolveDay(owner, shop.id, SUNDAY)).toHaveLength(1);
  });

  it("is inclusive at BOTH ends", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    // A single day off: the same date twice.
    await createLeave(owner, {
      userId: budi.userId,
      startDate: "2026-09-03",
      endDate: "2026-09-03",
      reason: "Doctor",
    });

    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
    expect(await resolveDay(owner, shop.id, FRIDAY)).toHaveLength(1);
  });

  it("leaves the recurring schedule completely untouched", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    const a = await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    await createLeave(owner, {
      userId: budi.userId,
      startDate: "2026-09-03",
      endDate: "2026-09-05",
      reason: "Annual leave",
    });

    // This is what makes Leave the right tool where Remove was the wrong one.
    const stored = await prisma.scheduleAssignment.findUnique({
      where: { id: a.id },
      select: { removedAt: true, daysOfWeek: true },
    });
    expect(stored?.removedAt).toBeNull();
    expect([...(stored?.daysOfWeek ?? [])].sort()).toEqual(ALL_DAYS);
  });

  it("beats an ADDED override — approved leave is not overridden by accident", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createOverride(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      businessDate: "2026-09-03",
      kind: "ADDED",
      reason: "Extra cover",
    });
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);

    // Leave granted afterwards must win: to bring them in, cancel the leave,
    // which leaves a record. Layering an override would not.
    await createLeave(owner, {
      userId: budi.userId,
      startDate: "2026-09-03",
      endDate: "2026-09-03",
      reason: "Sick",
    });
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);
  });

  it("applies at EVERY branch the person works at", async () => {
    const a1 = await makeShop("Branch One");
    const a2 = await makeShop("Branch Two");
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [a1.id, a2.id]);

    const s1 = await makeShift(owner, a1.id, "Morning", "08:00", "12:00");
    const s2 = await makeShift(owner, a2.id, "Evening", "12:00", "18:00");

    for (const [shopId, shiftId] of [
      [a1.id, s1.id],
      [a2.id, s2.id],
    ] as const) {
      await createAssignment(owner, shopId, {
        userId: budi.userId,
        shiftId,
        daysOfWeek: ALL_DAYS,
        effectiveFrom: "2026-09-01",
      });
    }

    // Somebody on holiday is away from the business, not from one branch.
    await createLeave(owner, {
      userId: budi.userId,
      startDate: "2026-09-03",
      endDate: "2026-09-03",
      reason: "Annual leave",
    });

    expect(await resolveDay(owner, a1.id, THURSDAY)).toHaveLength(0);
    expect(await resolveDay(owner, a2.id, THURSDAY)).toHaveLength(0);
  });

  it("can be scoped to ONE branch when asked", async () => {
    const a1 = await makeShop("Branch One");
    const a2 = await makeShop("Branch Two");
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [a1.id, a2.id]);

    const s1 = await makeShift(owner, a1.id, "Morning", "08:00", "12:00");
    const s2 = await makeShift(owner, a2.id, "Evening", "12:00", "18:00");

    for (const [shopId, shiftId] of [
      [a1.id, s1.id],
      [a2.id, s2.id],
    ] as const) {
      await createAssignment(owner, shopId, {
        userId: budi.userId,
        shiftId,
        daysOfWeek: ALL_DAYS,
        effectiveFrom: "2026-09-01",
      });
    }

    await createLeave(owner, {
      userId: budi.userId,
      shopId: a1.id,
      startDate: "2026-09-03",
      endDate: "2026-09-03",
      reason: "Not needed at Branch One",
    });

    expect(await resolveDay(owner, a1.id, THURSDAY)).toHaveLength(0);
    expect(await resolveDay(owner, a2.id, THURSDAY)).toHaveLength(1);
  });

  it("resumes the schedule when cancelled", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);
    const shift = await makeShift(owner, shop.id, "Morning", "08:00", "12:00");

    await createAssignment(owner, shop.id, {
      userId: budi.userId,
      shiftId: shift.id,
      daysOfWeek: ALL_DAYS,
      effectiveFrom: "2026-09-01",
    });

    const l = await createLeave(owner, {
      userId: budi.userId,
      startDate: "2026-09-03",
      endDate: "2026-09-05",
      reason: "Annual leave",
    });
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(0);

    await cancelLeave(owner, l.id);
    expect(await resolveDay(owner, shop.id, THURSDAY)).toHaveLength(1);
  });

  it("refuses a range that ends before it starts, and a blank reason", () => {
    const backwards = leaveSchema.safeParse({
      userId: "u1",
      startDate: "2026-09-10",
      endDate: "2026-09-01",
      reason: "Annual leave",
    });
    expect(backwards.success).toBe(false);

    const blank = leaveSchema.safeParse({
      userId: "u1",
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      reason: "  ",
    });
    expect(blank.success).toBe(false);
  });

  it("reports who is on leave today, and why", async () => {
    const shop = await makeShop();
    const owner = await makeUser("OWNER", []);
    const budi = await makeUser("STAFF", [shop.id]);

    await createLeave(owner, {
      userId: budi.userId,
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      reason: "Annual leave",
    });

    // Drives the clock-in screen saying WHY there is no prompt, rather than
    // showing an unexplained blank.
    const today = await leaveFor(budi.userId, shop.id, THURSDAY);
    expect(today).toMatchObject({ reason: "Annual leave", endDate: "2026-09-10" });

    const listed = await listLeave(owner, shop.id, { from: "2026-09-01" });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.isActiveToday).toBe(true);
  });

  it("refuses a MANAGER recording leave for someone at another branch", async () => {
    const mine = await makeShop("Mine");
    const theirs = await makeShop("Theirs");
    await makeUser("OWNER", []);
    const manager = await makeUser("MANAGER", [mine.id]);
    const stranger = await makeUser("STAFF", [theirs.id]);

    await expect(
      createLeave(manager, {
        userId: stranger.userId,
        startDate: "2026-09-03",
        endDate: "2026-09-03",
        reason: "Annual leave",
      })
    ).rejects.toThrow(AppError);
  });
});
