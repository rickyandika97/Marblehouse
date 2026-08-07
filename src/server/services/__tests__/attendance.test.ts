/**
 * Attendance service (PRD §4.13, §4.14, §7.7).
 *
 * These write real rows and clean up in `afterEach`, following
 * `redemption.test.ts` — the service opens its own transactions and writes
 * files to disk, so it cannot run inside `withRollback`'s.
 *
 * What is worth proving here rather than assuming:
 *
 *  - **One record per user per business day** (§4.13), including under a
 *    concurrent double-tap. The unique constraint is the arbiter; the service
 *    must turn the violation into a friendly conflict, not a 500.
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

async function fixture(opts: { role?: Actor["role"]; shiftStart?: string } = {}) {
  const shop = await makeShop(prisma, "Attendance");
  shopIds.push(shop.id);

  const id = uniq();
  const user = await prisma.user.create({
    data: {
      email: `att-${id}@marblehouse.invalid`,
      name: `Att ${id}`,
      username: `att-${id}`,
      displayName: `Att ${id}`,
      role: opts.role ?? "STAFF",
    },
    select: { id: true, displayName: true, username: true },
  });
  userIds.push(user.id);

  // A shift starting at the given wall-clock time, every day.
  const [h, m] = (opts.shiftStart ?? "09:00").split(":").map(Number);
  const shift = await prisma.shift.create({
    data: {
      shopId: shop.id,
      name: "Test shift",
      startTime: new Date(Date.UTC(1970, 0, 1, h, m, 0)),
      endTime: new Date(Date.UTC(1970, 0, 1, 17, 0, 0)),
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    },
    select: { id: true },
  });

  const actor = {
    sessionId: `sess-${id}`,
    userId: user.id,
    username: user.username ?? id,
    displayName: user.displayName,
    role: opts.role ?? "STAFF",
    isActive: true,
    mustChangePassword: false,
    canEnterCost: false,
    defaultShopId: shop.id,
    assignedShopIds: [shop.id],
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
      },
    });
    expect(row?.photoPath).toMatch(/^attendance[/\\]/);
    expect(row?.locationDenied).toBe(false);
    expect(row?.latitude?.toString()).toBe("-6.2");

    // §4.14: the shift start and grace are SNAPSHOTTED onto the record so a
    // later edit to the shift cannot rewrite this day's lateness.
    expect(row?.shiftStartAtCapture).not.toBeNull();
    expect(row?.graceMinAtCapture).toBe(5);
  });

  it("refuses a SECOND clock-in on the same business day", async () => {
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

  it("creates exactly one record when two clock-ins race", async () => {
    const { shop, shift, actor } = await fixture();

    const attempts = await Promise.allSettled([
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      }),
      clockIn(actor, shop.id, await photo(), {
        shiftId: shift.id,
        locationDenied: false,
      }),
    ]);

    for (const a of attempts) {
      if (a.status === "fulfilled") attendanceIds.push(a.value.id);
    }

    const ok = attempts.filter((a) => a.status === "fulfilled");
    // The unique constraint arbitrates — exactly one wins.
    expect(ok).toHaveLength(1);

    // The LOSER must fail cleanly. A double-tap on shop wifi is the expected
    // case, so it has to surface as a friendly CONFLICT, not a raw P2002
    // escaping as a 500. Asserting only "one succeeded" left the P2002 catch
    // untested — a mutation removing it kept every test green.
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
});

describe("read scoping (§3.4)", () => {
  it("lets a staff member read their own record but not another's", () => {
    const staff = {
      role: "STAFF",
      userId: "u1",
      assignedShopIds: ["s1"],
    } as unknown as Actor;

    expect(() => assertCanReadAttendance(staff, "u1", "s1")).not.toThrow();
    expect(() => assertCanReadAttendance(staff, "u2", "s1")).toThrow();
  });

  it("lets a manager read any record at their OWN shops only", () => {
    const manager = {
      role: "MANAGER",
      userId: "m1",
      assignedShopIds: ["s1"],
    } as unknown as Actor;

    expect(() => assertCanReadAttendance(manager, "u2", "s1")).not.toThrow();
    expect(() => assertCanReadAttendance(manager, "u2", "s2")).toThrow();
  });

  it("lets the owner read anything", () => {
    const owner = {
      role: "OWNER",
      userId: "o1",
      assignedShopIds: [],
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
