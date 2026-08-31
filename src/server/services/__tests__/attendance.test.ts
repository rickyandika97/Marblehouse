/**
 * Attendance service (PRD §4.13, §4.14, §7.7).
 *
 * These write real rows and clean up in `afterEach`, following
 * `redemption.test.ts` — the service opens its own transactions and writes
 * files to disk, so it cannot run inside `withRollback`'s.
 *
 * What is worth proving here rather than assuming:
 *
 *  - **One open shift per staff member**, including under a concurrent
 *    double-tap. A later shift only becomes available after clock-out.
 *  - **Lateness is snapshotted** (§4.14) so editing a shift later cannot
 *    rewrite history.
 *  - **A denied location is recorded, not refused** — the clock-in still
 *    succeeds and is flagged.
 *  - **The read rule** — staff see only themselves, a manager only their shops.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import sharp from "sharp";
import { prisma, makeShop, uniq } from "./helpers";
import {
  assertCanReadAttendance,
  attendanceStatus,
  clockIn,
  clockOut,
  editAttendance,
  listAttendance,
  listAttendanceAttention,
  localWeekday,
} from "../attendance";
import { deleteAttendancePhoto } from "../attendance-photo";
import type { Actor } from "@/server/auth/context";

const shopIds: string[] = [];
const userIds: string[] = [];
const attendanceIds: string[] = [];
const photoPaths: string[] = [];

const BUSINESS_DATE = new Date("2026-03-11T00:00:00.000Z"); // a Wednesday

afterEach(async () => {
  const rows = await prisma.attendance.findMany({
    where: { id: { in: attendanceIds } },
    select: { photoPath: true },
  });
  for (const r of rows) if (r.photoPath) photoPaths.push(r.photoPath);

  await prisma.auditLog.deleteMany({ where: { entityId: { in: attendanceIds } } });
  await prisma.attendance.deleteMany({ where: { id: { in: attendanceIds } } });
  await prisma.scheduleLeave.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.scheduleOverride.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.scheduleAssignment.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.shift.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });

  for (const p of photoPaths) await deleteAttendancePhoto(p).catch(() => {});

  attendanceIds.length = 0;
  photoPaths.length = 0;
  userIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A JPEG with no EXIF — what getUserMedia → canvas produces (D-44). */
async function photo(): Promise<ArrayBuffer> {
  const buf = await sharp({
    create: { width: 800, height: 600, channels: 3, background: "#556677" },
  })
    .jpeg()
    .toBuffer();
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength
  ) as ArrayBuffer;
}

async function fixture(
  opts: {
    role?: "OWNER" | "MANAGER" | "STAFF";
    shiftStart?: string;
    shiftEnd?: string;
  } = {}
) {
  const shop = await makeShop(prisma, "Attendance");
  shopIds.push(shop.id);

  const id = uniq();
  const role = opts.role ?? "STAFF";
  const user = await prisma.user.create({
    data: {
      email: `att-${id}@marblehouse.invalid`,
      name: `Att ${id}`,
      username: `att-${id}`,
      displayName: `Att ${id}`,
      isOwner: role === "OWNER",
    },
    select: { id: true, displayName: true, username: true },
  });
  userIds.push(user.id);

  // A shift starting at the given wall-clock time, every day.
  const [h, m] = (opts.shiftStart ?? "09:00").split(":").map(Number);
  const [endH, endM] = (opts.shiftEnd ?? "17:00").split(":").map(Number);
  const shift = await prisma.shift.create({
    data: {
      shopId: shop.id,
      name: "Test shift",
      startTime: new Date(Date.UTC(1970, 0, 1, h, m, 0)),
      endTime: new Date(Date.UTC(1970, 0, 1, endH, endM, 0)),
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    },
    select: { id: true },
  });

  const actor = {
    sessionId: `sess-${id}`,
    userId: user.id,
    username: user.username ?? id,
    displayName: user.displayName,
    isOwner: role === "OWNER",
    shopRoles:
      role === "OWNER"
        ? new Map()
        : new Map([[shop.id, { role, canEnterCost: false }]]),
    isActive: true,
    mustChangePassword: false,
    defaultShopId: shop.id,
    businessDate: BUSINESS_DATE,
    workSession: null,
  } as unknown as Actor;

  return { shop, user, shift, actor };
}

async function track<T extends { id: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  attendanceIds.push(r.id);
  return r;
}

describe("clock-in (§4.13)", () => {
  it("records a clock-in with a watermarked photo", async () => {
    const { shop, shift, actor } = await fixture();

    const result = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
        latitude: -6.2,
        longitude: 106.8,
        accuracyM: 10,
      })
    );

    expect(result.photoUrl).toBe(`/api/attendance/${result.id}/photo`);

    const row = await prisma.attendance.findUnique({
      where: { id: result.id },
      select: {
        photoPath: true,
        locationDenied: true,
        latitude: true,
        graceMinAtCapture: true,
        shiftStartAtCapture: true,
        shiftEndAtCapture: true,
      },
    });
    expect(row?.photoPath).toMatch(/^attendance[/\\]/);
    expect(row?.locationDenied).toBe(false);
    expect(row?.latitude?.toString()).toBe("-6.2");

    // §4.14: the shift start and grace are SNAPSHOTTED onto the record so a
    // later edit to the shift cannot rewrite this day's lateness.
    expect(row?.shiftStartAtCapture).not.toBeNull();
    expect(row?.shiftEndAtCapture).not.toBeNull();
    expect(row?.graceMinAtCapture).toBe(5);
  });

  it("refuses a SECOND clock-in for the same shift on the same business day", async () => {
    const { shop, shift, actor } = await fixture();

    await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    await expect(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    ).rejects.toThrow(/already clocked in/i);

    expect(
      await prisma.attendance.count({ where: { userId: actor.userId } })
    ).toBe(1);
  });

  it("requires clock-out before a later shift at a different shop", async () => {
    const { shop, shift, actor } = await fixture();
    const secondShop = await makeShop(prisma, "Later shift");
    shopIds.push(secondShop.id);
    await prisma.userShop.create({
      data: { userId: actor.userId, shopId: secondShop.id, role: "STAFF" },
    });
    actor.shopRoles.set(secondShop.id, { role: "STAFF", canEnterCost: false });
    const secondShift = await prisma.shift.create({
      data: {
        shopId: secondShop.id,
        name: "Evening shift",
        startTime: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)),
        endTime: new Date(Date.UTC(1970, 0, 1, 23, 0, 0)),
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
    });

    const first = await track(clockIn(actor, shop.id, await photo(), {
      shiftId: shift.id,
      locationDenied: true,
    }));

    await expect(clockIn(actor, secondShop.id, await photo(), {
      shiftId: secondShift.id,
      locationDenied: true,
    })).rejects.toThrow(/clock out.*before clocking in again/i);

    await clockOut(actor, { attendanceId: first.id });
    await track(clockIn(actor, secondShop.id, await photo(), {
      shiftId: secondShift.id,
      locationDenied: true,
    }));

    expect(await prisma.attendance.count({ where: { userId: actor.userId } })).toBe(2);
  });

  it("allows another shift at the same shop after clock-out", async () => {
    const { shop, shift, actor } = await fixture();
    const laterShift = await prisma.shift.create({
      data: {
        shopId: shop.id,
        name: "Evening shift",
        startTime: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)),
        endTime: new Date(Date.UTC(1970, 0, 1, 23, 0, 0)),
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
    });

    const first = await track(clockIn(actor, shop.id, await photo(), {
      shiftId: shift.id,
      locationDenied: true,
    }));
    await clockOut(actor, { attendanceId: first.id });
    await track(clockIn(actor, shop.id, await photo(), {
      shiftId: laterShift.id,
      locationDenied: true,
    }));

    expect(await prisma.attendance.count({ where: { userId: actor.userId } })).toBe(2);
  });

  it("creates exactly one record when two different shifts race", async () => {
    const { shop, shift, actor } = await fixture();
    const laterShift = await prisma.shift.create({
      data: {
        shopId: shop.id,
        name: "Concurrent later shift",
        startTime: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)),
        endTime: new Date(Date.UTC(1970, 0, 1, 23, 0, 0)),
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
    });

    const attempts = await Promise.allSettled([
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      }),
      clockIn(actor, shop.id, await photo(), {
        shiftId: laterShift.id,
        locationDenied: false,
      }),
    ]);

    for (const a of attempts) {
      if (a.status === "fulfilled") attendanceIds.push(a.value.id);
    }

    const ok = attempts.filter((a) => a.status === "fulfilled");
    // The per-person transaction lock arbitrates — exactly one wins.
    expect(ok).toHaveLength(1);

    // The LOSER must fail cleanly. A double-tap on shop wifi is the expected
    // case, so it has to surface as a friendly CONFLICT, not a raw database
    // error escaping as a 500.
    const loser = attempts.find((a) => a.status === "rejected");
    expect(loser).toBeDefined();
    const reason = (loser as PromiseRejectedResult).reason as {
      code?: string;
      message?: string;
    };
    expect(reason.code).toBe("CONFLICT");
    expect(reason.message).toMatch(/already clocked in/i);
    expect(
      await prisma.attendance.count({ where: { userId: actor.userId } })
    ).toBe(1);

    // And the loser left no orphan photo on disk.
    const files = await prisma.attendance.findMany({
      where: { userId: actor.userId },
      select: { photoPath: true },
    });
    expect(files).toHaveLength(1);
  });

  it("records a denied location instead of refusing the clock-in", async () => {
    const { shop, shift, actor } = await fixture();

    const result = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: true,
      })
    );

    expect(result.locationDenied).toBe(true);

    const row = await prisma.attendance.findUnique({
      where: { id: result.id },
      select: { locationDenied: true, latitude: true, longitude: true },
    });
    expect(row?.locationDenied).toBe(true);
    expect(row?.latitude).toBeNull();
    expect(row?.longitude).toBeNull();
  });

  it("treats missing coordinates as a denied location", async () => {
    const { shop, shift, actor } = await fixture();

    // Client claims permission was granted but sends nothing usable.
    const result = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    expect(result.locationDenied).toBe(true);
  });

  it("refuses a shift that belongs to another branch", async () => {
    const { shop, actor } = await fixture();
    const other = await fixture();

    await expect(
      clockIn(actor, shop.id, await photo(), {
        shiftId: other.shift.id,
        locationDenied: false,
      })
    ).rejects.toThrow(/not available at this branch/i);
  });

  it("refuses a shop the actor is not assigned to", async () => {
    const { shop, shift } = await fixture();
    const outsider = await fixture();

    await expect(
      clockIn(outsider.actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    ).rejects.toThrow();
  });
});

describe("attendance status — the red banner (§4.13)", () => {
  it("is required for STAFF and not yet satisfied", async () => {
    const { actor } = await fixture();
    const status = await attendanceStatus(actor);

    expect(status.required).toBe(true);
    expect(status.clockedIn).toBe(false);
    expect(status.record).toBeNull();
  });

  it("is NOT required for an OWNER (§4.13)", async () => {
    const { actor } = await fixture({ role: "OWNER" });
    expect((await attendanceStatus(actor)).required).toBe(false);
  });

  it("reports clocked-in once the record exists", async () => {
    const { shop, shift, actor } = await fixture();
    await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    const status = await attendanceStatus(actor);
    expect(status.clockedIn).toBe(true);
    expect(status.record?.clockInAt).toBeTruthy();
  });

  /**
   * The clock-out card reads these three off `attendanceStatus` (Phase 10).
   * Without the shift's end time it cannot say "ends 17:00", which is the whole
   * reason there is no nagging clock-out banner — the card informs instead.
   */
  it("carries the shop name and the shift's scheduled end time", async () => {
    const { shop, shift, actor } = await fixture();
    await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    const status = await attendanceStatus(actor);
    expect(status.record?.shopName).toBe(shop.name);
    // The fixture's shift ends at 17:00, formatted from a @db.Time column.
    expect(status.record?.shift?.endTime).toBe("17:00");
    expect(status.record?.clockOutAt).toBeNull();
  });

  it("prompts a staff member to clock out once their shift has ended", async () => {
    const { shop, shift, actor } = await fixture();
    await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    // 18:00 in the fixture shop's Asia/Jakarta timezone, after 17:00.
    const status = await attendanceStatus(actor, new Date("2026-03-11T11:00:00.000Z"));
    expect(status.clockOutPrompt).toEqual({
      // The banner deep-links to this id (D-172); it must name the record the
      // clock-out card is offering, or the tap opens nothing.
      attendanceId: status.openRecords[0]!.id,
      shopName: shop.name,
      shiftName: "Test shift",
      endTime: "17:00",
    });
  });

  it("does not prompt before a shift ends or after it is clocked out", async () => {
    const { shop, shift, actor } = await fixture();
    await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    expect(
      (await attendanceStatus(actor, new Date("2026-03-11T07:00:00.000Z"))).clockOutPrompt
    ).toBeNull();

    await clockOut(actor, {});
    expect(
      (await attendanceStatus(actor, new Date("2026-03-11T11:00:00.000Z"))).clockOutPrompt
    ).toBeNull();
  });

  /**
   * §8.9's "No shift applies — clock in anyway" path stores `shiftId: null`
   * (D-52). The card must render for that person too, so `shift` has to be a
   * clean null rather than a crash reading `endTime` off nothing.
   */
  it("returns a null shift for a clock-in with no shift chosen", async () => {
    const { shop, actor } = await fixture();
    await track(clockIn(actor, shop.id, await photo(), { locationDenied: false }));

    const status = await attendanceStatus(actor);
    expect(status.clockedIn).toBe(true);
    expect(status.record?.shift).toBeNull();
    expect(status.record?.shopName).toBe(shop.name);
  });

  it("reports clockOutAt once the shift is closed", async () => {
    const { shop, shift, actor } = await fixture();
    await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );
    await clockOut(actor, {});

    // The card hides itself on this, so a wrong value here leaves someone
    // able to tap "Clock out" on a shift they already finished.
    expect((await attendanceStatus(actor)).record?.clockOutAt).toBeTruthy();
  });
});

describe("clock-out", () => {
  it("records a clock-out and refuses a second one", async () => {
    const { shop, shift, actor } = await fixture();
    await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    const out = await clockOut(actor, {});
    expect(out.clockOutAt).toBeTruthy();

    await expect(clockOut(actor, {})).rejects.toThrow(/already clocked out/i);
  });

  it("refuses a clock-out with no clock-in", async () => {
    const { actor } = await fixture();
    await expect(clockOut(actor, {})).rejects.toThrow(/have not clocked in/i);
  });

  it("closes the selected open record", async () => {
    const { shop, shift, actor } = await fixture();
    const laterShift = await prisma.shift.create({
      data: {
        shopId: shop.id,
        name: "Later shift",
        startTime: new Date(Date.UTC(1970, 0, 1, 18, 0, 0)),
        endTime: new Date(Date.UTC(1970, 0, 1, 23, 0, 0)),
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
    });
    const first = await track(clockIn(actor, shop.id, await photo(), {
      shiftId: shift.id,
      locationDenied: true,
    }));
    await clockOut(actor, { attendanceId: first.id });
    const second = await track(clockIn(actor, shop.id, await photo(), {
      shiftId: laterShift.id,
      locationDenied: true,
    }));

    await clockOut(actor, { attendanceId: second.id });

    const rows = await prisma.attendance.findMany({
      where: { id: { in: [first.id, second.id] } },
      select: { id: true, clockOutAt: true },
    });
    expect(rows.find((row) => row.id === first.id)?.clockOutAt).not.toBeNull();
    expect(rows.find((row) => row.id === second.id)?.clockOutAt).not.toBeNull();
  });

  it("keeps a forgotten prior-day clock-out actionable and requires a reason and time", async () => {
    const { shop, user, shift, actor } = await fixture();
    const forgotten = await prisma.attendance.create({
      data: {
        userId: user.id,
        shopId: shop.id,
        shiftId: shift.id,
        businessDate: new Date("2026-03-10T00:00:00.000Z"),
        // 09:00 Asia/Jakarta on the preceding business day.
        clockInAt: new Date("2026-03-10T02:00:00.000Z"),
        shiftStartAtCapture: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
        shiftEndAtCapture: new Date(Date.UTC(1970, 0, 1, 17, 0, 0)),
      },
    });
    attendanceIds.push(forgotten.id);

    const status = await attendanceStatus(actor, new Date("2026-03-11T11:00:00.000Z"));
    expect(status.openRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: forgotten.id,
          businessDate: "2026-03-10",
          requiresReasonAndTimeConfirmation: true,
        }),
      ])
    );

    await expect(clockOut(actor, { attendanceId: forgotten.id })).rejects.toThrow(/why/i);
    await expect(
      clockOut(actor, { attendanceId: forgotten.id, note: "Forgot to clock out" })
    ).rejects.toThrow(/actual clock-out time/i);

    const closed = await clockOut(actor, {
      attendanceId: forgotten.id,
      note: "Forgot to clock out after closing",
      clockOutAt: "2026-03-10T11:20:00.000Z",
    });
    expect(closed.clockOutAt).toBe("2026-03-10T11:20:00.000Z");
  });
});

describe("read scoping (§3.4)", () => {
  it("lets a staff member read their own record but not another's", () => {
    const staff = {
      isOwner: false,
      userId: "u1",
      shopRoles: new Map([["s1", { role: "STAFF", canEnterCost: false }]]),
    } as unknown as Actor;

    expect(() => assertCanReadAttendance(staff, "u1", "s1")).not.toThrow();
    expect(() => assertCanReadAttendance(staff, "u2", "s1")).toThrow();
  });

  it("lets a manager read any record at their OWN shops only", () => {
    const manager = {
      isOwner: false,
      userId: "m1",
      shopRoles: new Map([["s1", { role: "MANAGER", canEnterCost: false }]]),
    } as unknown as Actor;

    expect(() => assertCanReadAttendance(manager, "u2", "s1")).not.toThrow();
    expect(() => assertCanReadAttendance(manager, "u2", "s2")).toThrow();
  });

  it("lets the owner read anything", () => {
    const owner = {
      isOwner: true,
      userId: "o1",
      shopRoles: new Map(),
    } as unknown as Actor;

    expect(() => assertCanReadAttendance(owner, "u2", "s9")).not.toThrow();
  });

  it("scopes a STAFF list query to their own records in SQL", async () => {
    const { shop, shift, actor } = await fixture();
    const other = await fixture();

    await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );
    await track(
      clockIn(other.actor, other.shop.id, await photo(), {
        shiftId: other.shift.id,
        locationDenied: false,
      })
    );

    const mine = await listAttendance(actor, {});
    expect(mine.every((r) => r.user.id === actor.userId)).toBe(true);
  });

  it("never returns a filesystem path, only an authenticated URL (§4.15)", async () => {
    const { shop, shift, actor } = await fixture();
    const r = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    const rows = await listAttendance(actor, {});
    const serialized = JSON.stringify(rows);

    expect(serialized).toContain(`/api/attendance/${r.id}/photo`);
    expect(serialized).not.toContain("photoPath");
    expect(serialized).not.toMatch(/attendance[/\\]\d{4}[/\\]/);
  });
});

it("lists only rostered shifts that have started behind today's dashboard attendance alerts", async () => {
  const staff = await fixture();
  const owner = await fixture({ role: "OWNER" });

  // Branch assignment alone is not an alert: the employee must be rostered.
  await prisma.userShop.create({
    data: { userId: staff.actor.userId, shopId: staff.shop.id, role: "STAFF" },
  });
  await prisma.scheduleAssignment.create({
    data: {
      userId: staff.actor.userId,
      shopId: staff.shop.id,
      shiftId: staff.shift.id,
      daysOfWeek: [3],
      effectiveFrom: staff.actor.businessDate,
      createdById: owner.actor.userId,
    },
  });

  const afternoonShift = await prisma.shift.create({
    data: {
      shopId: staff.shop.id,
      name: "Afternoon shift",
      startTime: new Date(Date.UTC(1970, 0, 1, 16, 0, 0)),
      endTime: new Date(Date.UTC(1970, 0, 1, 20, 0, 0)),
      daysOfWeek: [3],
    },
  });
  await prisma.scheduleAssignment.create({
    data: {
      userId: staff.actor.userId,
      shopId: staff.shop.id,
      shiftId: afternoonShift.id,
      daysOfWeek: [3],
      effectiveFrom: staff.actor.businessDate,
      createdById: owner.actor.userId,
    },
  });

  const missing = await listAttendanceAttention(owner.actor, {
    issue: "not-clocked-in",
    shopId: staff.shop.id,
  }, new Date("2026-03-11T04:00:00.000Z")); // 11:00 Asia/Jakarta
  expect(missing).toEqual([
    expect.objectContaining({
      userId: staff.actor.userId,
      displayName: staff.user.displayName,
      shop: expect.objectContaining({ id: staff.shop.id }),
      shift: expect.objectContaining({ id: staff.shift.id, name: "Test shift" }),
    }),
  ]);

  const record = await prisma.attendance.create({
    data: {
      userId: staff.actor.userId,
      shopId: staff.shop.id,
      shiftId: staff.shift.id,
      businessDate: staff.actor.businessDate,
      clockInAt: new Date("2026-03-11T02:30:00.000Z"),
      isLate: true,
      lateMinutes: 25,
      status: "LATE",
    },
  });
  attendanceIds.push(record.id);

  const late = await listAttendanceAttention(owner.actor, {
    issue: "late",
    shopId: staff.shop.id,
  });
  expect(late).toHaveLength(1);
  expect(late[0]).toMatchObject({
    id: record.id,
    user: { id: staff.actor.userId, displayName: staff.user.displayName },
    isLate: true,
    lateMinutes: 25,
  });

  // A morning record satisfies only its own shift. Once the 16:00 shift
  // starts, the same employee is correctly alerted for that separate arrival.
  const afterAfternoonStarts = await listAttendanceAttention(
    owner.actor,
    { issue: "not-clocked-in", shopId: staff.shop.id },
    new Date("2026-03-11T10:00:00.000Z") // 17:00 Asia/Jakarta
  );
  expect(afterAfternoonStarts).toEqual([
    expect.objectContaining({
      userId: staff.actor.userId,
      shift: expect.objectContaining({ id: afternoonShift.id, name: "Afternoon shift" }),
    }),
  ]);
});

it("filters attendance history by employee, date, late, and early arrival", async () => {
  const { shop, user, shift, actor } = await fixture();
  const owner = await fixture({ role: "OWNER" });
  const laterShift = await prisma.shift.create({
    data: {
      shopId: shop.id,
      name: "Later test shift",
      startTime: new Date(Date.UTC(1970, 0, 1, 16, 0, 0)),
      endTime: new Date(Date.UTC(1970, 0, 1, 20, 0, 0)),
      daysOfWeek: [3],
    },
  });

  const [early, late] = await Promise.all([
    prisma.attendance.create({
      data: {
        userId: user.id,
        shopId: shop.id,
        shiftId: shift.id,
        businessDate: actor.businessDate,
        // 08:30 Asia/Jakarta, before the captured 09:00 shift start.
        clockInAt: new Date("2026-03-11T01:30:00.000Z"),
        clockOutAt: new Date("2026-03-11T08:00:00.000Z"),
        shiftStartAtCapture: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
      },
    }),
    prisma.attendance.create({
      data: {
        userId: user.id,
        shopId: shop.id,
        shiftId: laterShift.id,
        businessDate: actor.businessDate,
        clockInAt: new Date("2026-03-11T09:10:00.000Z"), // 16:10 Asia/Jakarta
        clockOutAt: new Date("2026-03-11T13:00:00.000Z"),
        shiftStartAtCapture: new Date(Date.UTC(1970, 0, 1, 16, 0, 0)),
        isLate: true,
        lateMinutes: 10,
        status: "LATE",
        scheduleSource: "COVER",
        coverReason: "Covering an absent colleague",
      },
    }),
  ]);
  attendanceIds.push(early.id, late.id);

  const byName = await listAttendance(owner.actor, {
    shopId: shop.id,
    q: user.displayName.toUpperCase(),
  });
  expect(byName).toHaveLength(2);

  const earlyOnly = await listAttendance(owner.actor, {
    shopId: shop.id,
    arrival: "early",
  });
  expect(earlyOnly.map((row) => row.id)).toEqual([early.id]);

  const lateOnly = await listAttendance(owner.actor, {
    shopId: shop.id,
    arrival: "late",
  });
  expect(lateOnly.map((row) => row.id)).toEqual([late.id]);

  const outsideSchedule = await listAttendance(owner.actor, {
    shopId: shop.id,
    outsideSchedule: true,
  });
  expect(outsideSchedule).toEqual([
    expect.objectContaining({
      id: late.id,
      scheduleSource: "COVER",
      coverReason: "Covering an absent colleague",
    }),
  ]);

  const otherDate = await listAttendance(owner.actor, {
    shopId: shop.id,
    from: "2026-03-12",
    to: "2026-03-12",
  });
  expect(otherDate).toEqual([]);
});

it("returns completed work and overtime from the captured scheduled end", async () => {
  const { shop, user, shift, actor } = await fixture();
  const row = await prisma.attendance.create({
    data: {
      userId: user.id,
      shopId: shop.id,
      shiftId: shift.id,
      businessDate: actor.businessDate,
      // 09:00 → 18:20 Asia/Jakarta = 9h 20m worked, 1h 20m after a 17:00 end.
      clockInAt: new Date("2026-03-11T02:00:00.000Z"),
      clockOutAt: new Date("2026-03-11T11:20:00.000Z"),
      shiftStartAtCapture: new Date(Date.UTC(1970, 0, 1, 9, 0, 0)),
      shiftEndAtCapture: new Date(Date.UTC(1970, 0, 1, 17, 0, 0)),
    },
  });
  attendanceIds.push(row.id);

  const [listed] = await listAttendance(actor, { mineOnly: true });
  expect(listed).toMatchObject({
    id: row.id,
    clockOutAt: "2026-03-11T11:20:00.000Z",
    workedMinutes: 560,
    overtimeMinutes: 80,
  });
});

it("keeps a multi-branch manager's team list to branches they manage", async () => {
  const manager = await fixture({ role: "MANAGER" });
  const staffBranch = await fixture();

  await prisma.userShop.create({
    data: {
      userId: manager.actor.userId,
      shopId: staffBranch.shop.id,
      role: "STAFF",
    },
  });
  manager.actor.shopRoles.set(staffBranch.shop.id, {
    role: "STAFF",
    canEnterCost: false,
  });

  const today = await prisma.attendance.create({
    data: {
      userId: manager.actor.userId,
      shopId: manager.shop.id,
      businessDate: manager.actor.businessDate,
      clockInAt: new Date("2026-03-11T02:00:00.000Z"),
      clockOutAt: new Date("2026-03-11T10:00:00.000Z"),
    },
  });
  const previousDay = new Date(manager.actor.businessDate);
  previousDay.setUTCDate(previousDay.getUTCDate() - 1);
  const staffBranchRecord = await prisma.attendance.create({
    data: {
      userId: manager.actor.userId,
      shopId: staffBranch.shop.id,
      businessDate: previousDay,
      clockInAt: new Date("2026-03-10T02:00:00.000Z"),
      clockOutAt: new Date("2026-03-10T10:00:00.000Z"),
    },
  });
  attendanceIds.push(today.id, staffBranchRecord.id);

  const team = await listAttendance(manager.actor, {});
  expect(team.map((row) => row.shop.id)).toEqual([manager.shop.id]);

  const mine = await listAttendance(manager.actor, { mineOnly: true });
  expect(mine.map((row) => row.shop.id)).toEqual(
    expect.arrayContaining([manager.shop.id, staffBranch.shop.id])
  );
});

describe("owner edit / excuse (§4.13)", () => {
  it("clears lateness when a record is excused", async () => {
    const { shop, shift, actor } = await fixture();
    const owner = await fixture({ role: "OWNER" });

    const record = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    // Force the record late so the excuse has something to clear.
    await prisma.attendance.update({
      where: { id: record.id },
      data: { isLate: true, lateMinutes: 22, status: "LATE" },
    });

    const updated = await editAttendance(owner.actor, record.id, {
      status: "EXCUSED",
      note: "Approved — traffic",
    });

    expect(updated.status).toBe("EXCUSED");
    // An excused record that still counted as late would contradict the
    // owner's own decision in every lateness report.
    expect(updated.isLate).toBe(false);
    expect(updated.lateMinutes).toBe(0);
  });

  it("writes an audit row with before and after values", async () => {
    const { shop, shift, actor } = await fixture();
    const owner = await fixture({ role: "OWNER" });

    const record = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );
    await editAttendance(owner.actor, record.id, { status: "EXCUSED" });

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: record.id, action: "ATTENDANCE_EDIT" },
      select: { before: true, after: true },
    });
    expect(audit).not.toBeNull();
    expect(JSON.stringify(audit?.after)).toContain("EXCUSED");
  });

  it("refuses a non-owner", async () => {
    const { shop, shift, actor } = await fixture();
    const manager = await fixture({ role: "MANAGER" });

    const record = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    await expect(
      editAttendance(manager.actor, record.id, { status: "EXCUSED" })
    ).rejects.toThrow(/only the owner/i);
  });
});

describe("localWeekday", () => {
  it("reads the day of week in the shop's timezone, not the server's", () => {
    // 20:00 UTC on Friday 7 Aug 2026 is already Saturday in Jakarta (+7).
    const at = new Date("2026-08-07T20:00:00.000Z");
    expect(localWeekday(at, "Asia/Jakarta")).toBe(6); // Saturday
    expect(localWeekday(at, "UTC")).toBe(5); // still Friday
  });
});

// ──────────────── the timetable gate (§4.14.1, D-136) ────────────────

describe("§4.14.1 — the roster decides SCHEDULED vs COVER", () => {
  /**
   * The three branches, and why each matters:
   *
   *   1. No roster at all      → SCHEDULED, no prompt. Every branch that
   *                              predates the timetable, and every new one on
   *                              its first day. If this broke, shipping the
   *                              feature would lock every existing shop out.
   *   2. Rostered              → SCHEDULED, no reason needed. The normal day.
   *   3. Someone else rostered → COVER, and a reason is REQUIRED but never a
   *                              refusal. A branch that cannot open because the
   *                              roster is stale is the worse failure.
   */

  it("treats a branch with NO roster as scheduled, exactly as before", async () => {
    const { shop, actor } = await fixture({ role: "STAFF" });

    // Nobody is rostered here at all. This must behave as it did pre-§4.14.1.
    const record = await track(
      clockIn(actor, shop.id, await photo(), { locationDenied: false })
    );

    expect(record.scheduleSource).toBe("SCHEDULED");
  });

  it("records SCHEDULED with no reason when the roster names you", async () => {
    const { shop, shift, actor, user } = await fixture({ role: "STAFF" });

    await prisma.scheduleAssignment.create({
      data: {
        userId: user.id,
        shopId: shop.id,
        shiftId: shift.id,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      },
    });

    const record = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    );

    expect(record.scheduleSource).toBe("SCHEDULED");
  });

  it("REFUSES without a reason when someone else holds the roster", async () => {
    const { shop, shift, actor } = await fixture({ role: "STAFF" });
    const colleague = await fixture({ role: "STAFF" });

    // Budi is rostered at THIS shop; the actor is not.
    await prisma.userShop.create({
      data: { userId: colleague.user.id, shopId: shop.id, role: "STAFF" },
    });
    await prisma.scheduleAssignment.create({
      data: {
        userId: colleague.user.id,
        shopId: shop.id,
        shiftId: shift.id,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      },
    });

    await expect(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      })
    ).rejects.toThrow(/not scheduled/i);
  });

  it("ALLOWS the same clock-in once a reason is given, flagged COVER", async () => {
    const { shop, shift, actor } = await fixture({ role: "STAFF" });
    const colleague = await fixture({ role: "STAFF" });

    await prisma.userShop.create({
      data: { userId: colleague.user.id, shopId: shop.id, role: "STAFF" },
    });
    await prisma.scheduleAssignment.create({
      data: {
        userId: colleague.user.id,
        shopId: shop.id,
        shiftId: shift.id,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      },
    });

    // The point of the whole design: covering is allowed, not blocked. Both
    // branches of the gate are proven — D-34's rule.
    const record = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        coverReason: "Covering for Budi, he is sick",
        locationDenied: false,
      })
    );

    expect(record.scheduleSource).toBe("COVER");

    const stored = await prisma.attendance.findUnique({
      where: { id: record.id },
      select: { coverReason: true, scheduleSource: true },
    });
    expect(stored?.coverReason).toBe("Covering for Budi, he is sick");
  });

  it("never stores a cover reason on a SCHEDULED row", async () => {
    const { shop, actor } = await fixture({ role: "STAFF" });

    // No roster here, so this is SCHEDULED — but a reason was sent anyway.
    // Keeping it would fill the cover report with noise.
    const record = await track(
      clockIn(actor, shop.id, await photo(), {
        coverReason: "sent by mistake",
        locationDenied: false,
      })
    );

    const stored = await prisma.attendance.findUnique({
      where: { id: record.id },
      select: { coverReason: true, scheduleSource: true },
    });
    expect(stored?.scheduleSource).toBe("SCHEDULED");
    expect(stored?.coverReason).toBeNull();
  });
});

describe("§4.14.2 — leave silences the clock-in prompt (D-140)", () => {
  it("does not prompt someone on leave, even with a live schedule", async () => {
    const { shop, shift, actor, user } = await fixture({ role: "STAFF" });

    await prisma.scheduleAssignment.create({
      data: {
        userId: user.id,
        shopId: shop.id,
        shiftId: shift.id,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      },
    });

    // Rostered → prompted. Establish the baseline, or the assertion below
    // proves nothing (a false could just mean the roster never worked).
    const before = await attendanceStatus({
      ...actor,
      workSession: { shopId: shop.id },
    } as unknown as Actor);
    expect(before.prompt).toBe(true);

    await prisma.scheduleLeave.create({
      data: {
        userId: user.id,
        startDate: new Date("2026-03-10T00:00:00.000Z"),
        endDate: new Date("2026-03-12T00:00:00.000Z"),
        reason: "Annual leave",
      },
    });

    // BUSINESS_DATE is 2026-03-11, inside the leave.
    const after = await attendanceStatus({
      ...actor,
      workSession: { shopId: shop.id },
    } as unknown as Actor);
    expect(after.prompt).toBe(false);
    expect(after.scheduledToday).toBe(false);
  });

  it("still lets someone on leave clock in WITH a reason", async () => {
    const { shop, shift, actor, user } = await fixture({ role: "STAFF" });
    const colleague = await fixture({ role: "STAFF" });

    // A roster exists here (somebody else is on it), so the cover gate is live.
    await prisma.userShop.create({
      data: { userId: colleague.user.id, shopId: shop.id, role: "STAFF" },
    });
    await prisma.scheduleAssignment.create({
      data: {
        userId: colleague.user.id,
        shopId: shop.id,
        shiftId: shift.id,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      },
    });
    await prisma.scheduleLeave.create({
      data: {
        userId: user.id,
        startDate: new Date("2026-03-10T00:00:00.000Z"),
        endDate: new Date("2026-03-12T00:00:00.000Z"),
        reason: "Annual leave",
      },
    });

    // Leave suppresses the PROMPT; it must never block the RECORD. Somebody
    // who comes in to cover during their holiday still has to be recordable.
    const record = await track(
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        coverReason: "Came in to cover for a sick colleague",
        locationDenied: false,
      })
    );
    expect(record.scheduleSource).toBe("COVER");
  });
});

describe("§4.14.1 — the Settings clock-in route (D-141)", () => {
  /**
   * The banner only fires when the roster expects someone, which is right —
   * and leaves a covering staff member with no route to the clock-in screen.
   * The Settings row is that route, and it reads `attendanceStatus`, so these
   * pin the three states it renders from.
   */
  it("reports not-scheduled and not-clocked-in for a covering staff member", async () => {
    const { shop, actor } = await fixture({ role: "STAFF" });
    const colleague = await fixture({ role: "STAFF" });

    // Somebody else holds the roster here, so this person is off it.
    await prisma.userShop.create({
      data: { userId: colleague.user.id, shopId: shop.id, role: "STAFF" },
    });
    await prisma.scheduleAssignment.create({
      data: {
        userId: colleague.user.id,
        shopId: shop.id,
        shiftId: colleague.shift.id,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        effectiveFrom: new Date("2026-03-01T00:00:00.000Z"),
      },
    });

    const status = await attendanceStatus({
      ...actor,
      workSession: { shopId: shop.id },
    } as unknown as Actor);

    // No banner (that is the point), but the row must still offer the route.
    expect(status.prompt).toBe(false);
    expect(status.scheduledToday).toBe(false);
    expect(status.clockedIn).toBe(false);
  });

  it("reports clockedIn with the time once they have covered", async () => {
    const { shop, actor } = await fixture({ role: "STAFF" });

    await track(clockIn(actor, shop.id, await photo(), { locationDenied: false }));

    const status = await attendanceStatus({
      ...actor,
      workSession: { shopId: shop.id },
    } as unknown as Actor);

    // Drives the row saying "Clocked in at HH:MM" rather than offering a
    // clock-in to somebody who already has.
    expect(status.clockedIn).toBe(true);
    expect(status.record?.clockInAt).toBeTruthy();
    expect(status.prompt).toBe(false);
  });
});
