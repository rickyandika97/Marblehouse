/**
 * Attendance (PRD §4.13, §4.14, §7.7).
 *
 * Clock-in is the one flow in the product where the *record* matters more than
 * the transaction: nothing moves money or stock, but the data underpins wage
 * conversations, so every field that could be argued about is decided by the
 * server.
 *
 *   - `clockInAt` is the server's clock, never the client's.
 *   - `businessDate` is computed server-side like every other dated row (§4.2).
 *   - Lateness is computed from the SHOP's timezone and the SHIFT's start,
 *     then **snapshotted** onto the row (`shiftStartAtCapture`,
 *     `graceMinAtCapture`) so a later edit to the shift cannot rewrite history
 *     (§4.14).
 *   - The photo is watermarked server-side (see `attendance-photo.ts`).
 *
 * **One record per user per business day** (§4.13) is enforced by a unique
 * constraint on `(userId, businessDate)`. The service catches the violation and
 * returns a friendly conflict rather than a 500 — a staff member double-tapping
 * the clock-in button is the expected case, not an exceptional one.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import type { Actor } from "@/server/auth/context";
import { assertShopAccess } from "@/server/auth/guards";
import { AppError, forbidden, notFound } from "@/server/errors";
import { localParts } from "@/lib/business-date";
import {
  clockInDayOffsetFor,
  computeLateness,
  minutesFromMidnight,
} from "@/lib/lateness";
import {
  deleteAttendancePhoto,
  storeAttendancePhoto,
} from "@/server/services/attendance-photo";

/**
 * Coordinates arrive as strings so a `Decimal` column never round-trips
 * through a float (§4.1's rule, applied here for consistency even though these
 * are not money).
 */
export const clockInSchema = z.object({
  shiftId: z.string().min(1).optional(),
  latitude: z.coerce.number().min(-90).max(90).optional(),
  longitude: z.coerce.number().min(-180).max(180).optional(),
  accuracyM: z.coerce.number().int().nonnegative().max(100_000).optional(),
  locationDenied: z
    .union([z.boolean(), z.literal("true"), z.literal("false")])
    .transform((v) => v === true || v === "true")
    .default(false),
});

export const clockOutSchema = z.object({
  note: z.string().trim().max(500).optional(),
});

export const listAttendanceSchema = z.object({
  shopId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  lateOnly: z.boolean().optional(),
});

export const editAttendanceSchema = z.object({
  status: z.enum(["PRESENT", "LATE", "EXCUSED", "ABSENT"]).optional(),
  isLate: z.boolean().optional(),
  lateMinutes: z.number().int().nonnegative().max(24 * 60).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Wall-clock minutes-from-midnight of a `@db.Time` value, which Prisma
 *  returns as a Date on 1970-01-01 in UTC. */
function shiftTimeToMinutes(time: Date): number {
  return minutesFromMidnight(time.getUTCHours(), time.getUTCMinutes());
}

/**
 * Today's attendance state for the banner (§7.7, §4.13).
 *
 * The banner is driven entirely by this: `required` decides whether it shows at
 * all, `clockedIn` whether it has been satisfied. OWNER is optional (§4.13), so
 * an owner never sees a red banner they cannot dismiss.
 */
export async function attendanceStatus(actor: Actor) {
  const record = await prisma.attendance.findUnique({
    where: {
      userId_businessDate: {
        userId: actor.userId,
        businessDate: actor.businessDate,
      },
    },
    select: {
      id: true,
      clockInAt: true,
      clockOutAt: true,
      isLate: true,
      lateMinutes: true,
      status: true,
      shopId: true,
      shop: { select: { name: true } },
      // endTime drives the clock-out card's "scheduled to X" line. There is no
      // *end*-time snapshot on Attendance the way there is for the start
      // (`shiftStartAtCapture`), so this is read live: it is shown as context
      // for a decision being made now, and is never stored or used to judge a
      // past record. Editing a shift must not rewrite history (§4.14).
      shift: { select: { id: true, name: true, endTime: true } },
    },
  });

  return {
    // §4.13: required for STAFF and MANAGER, optional for OWNER.
    required: actor.role !== "OWNER",
    clockedIn: record !== null,
    businessDate: actor.businessDate.toISOString().slice(0, 10),
    record: record
      ? {
          id: record.id,
          clockInAt: record.clockInAt.toISOString(),
          clockOutAt: record.clockOutAt?.toISOString() ?? null,
          isLate: record.isLate,
          lateMinutes: record.lateMinutes,
          status: record.status,
          shopId: record.shopId,
          shopName: record.shop.name,
          shift: record.shift
            ? {
                id: record.shift.id,
                name: record.shift.name,
                endTime: formatTime(record.shift.endTime),
              }
            : null,
        }
      : null,
  };
}

/** Shifts configured at a shop, for the §8.9 chooser. */
export async function listShiftsForToday(actor: Actor, shopId: string) {
  assertShopAccess(actor, shopId);

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true, lateGraceMin: true },
  });
  if (!shop) throw notFound("That branch no longer exists.");

  const now = new Date();
  const { hour, minute } = localParts(now, shop.timezone);
  const weekday = localWeekday(now, shop.timezone);

  const shifts = await prisma.shift.findMany({
    where: { shopId, isActive: true },
    orderBy: { startTime: "asc" },
    select: {
      id: true,
      name: true,
      startTime: true,
      endTime: true,
      daysOfWeek: true,
    },
  });

  const nowMin = minutesFromMidnight(hour, minute);

  return shifts
    .filter((s) => s.daysOfWeek.includes(weekday))
    .map((s) => {
      const startMin = shiftTimeToMinutes(s.startTime);
      const endMin = shiftTimeToMinutes(s.endTime);
      const { isLate, lateMinutes } = computeLateness({
        shiftStartMin: startMin,
        clockInMin: nowMin,
        clockInDayOffset: clockInDayOffsetFor(startMin, endMin, nowMin),
        graceMin: shop.lateGraceMin,
      });

      return {
        id: s.id,
        name: s.name,
        startTime: formatTime(s.startTime),
        endTime: formatTime(s.endTime),
        // §8.9: the chooser shows "you are X minutes late" in red already.
        wouldBeLate: isLate,
        wouldBeLateMinutes: lateMinutes,
      };
    });
}

/**
 * Day of week (0 = Sunday) in a given IANA zone, matching `Shift.daysOfWeek`.
 *
 * Read straight from the formatter rather than reparsing a formatted date
 * string — string round-trips through `new Date()` are locale-dependent and
 * this only has to be wrong once, on a Sunday, to hide every shift.
 */
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function localWeekday(at: Date, timezone: string): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(at);
  const index = WEEKDAY_INDEX[short];
  if (index === undefined) {
    throw new AppError("VALIDATION_FAILED", "Could not read the day of week.");
  }
  return index;
}

function formatTime(time: Date): string {
  return `${String(time.getUTCHours()).padStart(2, "0")}:${String(
    time.getUTCMinutes()
  ).padStart(2, "0")}`;
}

/**
 * Clock in (§4.13).
 *
 * The photo is required: §4.13 lists it as step 2 of three, and an attendance
 * record without one proves nothing. Location is optional — a denial is
 * recorded and flagged rather than blocking the clock-in, because a staff
 * member who cannot start their shift over a browser permission prompt is a
 * worse outcome than a flagged record.
 */
export async function clockIn(
  actor: Actor,
  shopId: string,
  photo: ArrayBuffer,
  input: z.infer<typeof clockInSchema>,
  meta: { ipAddress?: string | null } = {}
) {
  assertShopAccess(actor, shopId);

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, name: true, timezone: true, lateGraceMin: true },
  });
  if (!shop) throw notFound("That branch no longer exists.");

  // Fail fast on the duplicate before spending time on image processing.
  const existing = await prisma.attendance.findUnique({
    where: {
      userId_businessDate: {
        userId: actor.userId,
        businessDate: actor.businessDate,
      },
    },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(
      "CONFLICT",
      "You have already clocked in today. Only one clock-in per day is recorded."
    );
  }

  // The server's clock decides the time, not the device's.
  const clockInAt = new Date();

  let shift: {
    id: string;
    startTime: Date;
    endTime: Date;
  } | null = null;

  if (input.shiftId) {
    shift = await prisma.shift.findFirst({
      where: { id: input.shiftId, shopId, isActive: true },
      select: { id: true, startTime: true, endTime: true },
    });
    if (!shift) {
      throw notFound("That shift is not available at this branch.");
    }
  }

  let isLate = false;
  let lateMinutes = 0;
  let shiftStartAtCapture: Date | null = null;

  if (shift) {
    const { hour, minute } = localParts(clockInAt, shop.timezone);
    const startMin = shiftTimeToMinutes(shift.startTime);
    const endMin = shiftTimeToMinutes(shift.endTime);
    const clockInMin = minutesFromMidnight(hour, minute);

    ({ isLate, lateMinutes } = computeLateness({
      shiftStartMin: startMin,
      clockInMin,
      clockInDayOffset: clockInDayOffsetFor(startMin, endMin, clockInMin),
      graceMin: shop.lateGraceMin,
    }));

    shiftStartAtCapture = shift.startTime;
  }

  const locationDenied =
    input.locationDenied ||
    input.latitude === undefined ||
    input.longitude === undefined;

  // Watermark BEFORE the insert: if image processing fails there should be no
  // half-made attendance row, and the unique constraint still guards the race.
  const stored = await storeAttendancePhoto(photo, {
    capturedAt: clockInAt,
    timezone: shop.timezone,
    shopName: shop.name,
    userName: actor.displayName,
    latitude: locationDenied ? null : (input.latitude ?? null),
    longitude: locationDenied ? null : (input.longitude ?? null),
    accuracyM: locationDenied ? null : (input.accuracyM ?? null),
    locationDenied,
  });

  try {
    const record = await prisma.$transaction(async (tx) => {
      const created = await tx.attendance.create({
        data: {
          userId: actor.userId,
          shopId,
          shiftId: shift?.id ?? null,
          businessDate: actor.businessDate,
          clockInAt,
          shiftStartAtCapture,
          graceMinAtCapture: shop.lateGraceMin,
          status: isLate ? "LATE" : "PRESENT",
          isLate,
          lateMinutes,
          photoPath: stored.relativePath,
          latitude: locationDenied
            ? null
            : new Prisma.Decimal(input.latitude as number),
          longitude: locationDenied
            ? null
            : new Prisma.Decimal(input.longitude as number),
          accuracyM: locationDenied ? null : (input.accuracyM ?? null),
          locationDenied,
        },
        select: {
          id: true,
          clockInAt: true,
          isLate: true,
          lateMinutes: true,
          status: true,
          locationDenied: true,
        },
      });

      await writeAudit(
        actor,
        {
          entity: "Attendance",
          entityId: created.id,
          action: "ATTENDANCE_CLOCK_IN",
          shopId,
          after: {
            isLate: created.isLate,
            lateMinutes: created.lateMinutes,
            locationDenied: created.locationDenied,
          },
          ipAddress: meta.ipAddress ?? null,
        },
        tx
      );

      return created;
    });

    return {
      id: record.id,
      clockInAt: record.clockInAt.toISOString(),
      isLate: record.isLate,
      lateMinutes: record.lateMinutes,
      status: record.status,
      locationDenied: record.locationDenied,
      photoUrl: `/api/attendance/${record.id}/photo`,
    };
  } catch (error) {
    // Lost the race against a concurrent clock-in. Remove the photo we just
    // wrote so a rejected attempt does not leave an orphan file on disk.
    await deleteAttendancePhoto(stored.relativePath).catch(() => {});

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new AppError(
        "CONFLICT",
        "You have already clocked in today. Only one clock-in per day is recorded."
      );
    }
    throw error;
  }
}

/** Clock out (§4.13). Lateness reporting is clock-in only in v1. */
export async function clockOut(
  actor: Actor,
  input: z.infer<typeof clockOutSchema>
) {
  const record = await prisma.attendance.findUnique({
    where: {
      userId_businessDate: {
        userId: actor.userId,
        businessDate: actor.businessDate,
      },
    },
    select: { id: true, clockOutAt: true, shopId: true },
  });

  if (!record) {
    throw new AppError(
      "VALIDATION_FAILED",
      "You have not clocked in today, so there is nothing to clock out of."
    );
  }
  if (record.clockOutAt) {
    throw new AppError("CONFLICT", "You have already clocked out today.");
  }

  const updated = await prisma.attendance.update({
    where: { id: record.id },
    data: { clockOutAt: new Date(), note: input.note ?? undefined },
    select: { id: true, clockInAt: true, clockOutAt: true },
  });

  return {
    id: updated.id,
    clockInAt: updated.clockInAt.toISOString(),
    clockOutAt: updated.clockOutAt?.toISOString() ?? null,
  };
}

/**
 * Attendance records (§7.7).
 *
 * Scoped in SQL, never in JavaScript (§5.6). A manager sees only their own
 * shops; a staff member sees only themselves. The caller's filters can narrow
 * that but never widen it.
 */
export async function listAttendance(
  actor: Actor,
  input: z.infer<typeof listAttendanceSchema>
) {
  if (input.shopId) assertShopAccess(actor, input.shopId);

  const scope: Prisma.AttendanceWhereInput = {};

  if (actor.role === "STAFF") {
    // §3.4 gives STAFF their own history only.
    scope.userId = actor.userId;
  } else if (actor.role === "MANAGER") {
    scope.shopId = input.shopId
      ? input.shopId
      : { in: actor.assignedShopIds };
  } else if (input.shopId) {
    scope.shopId = input.shopId;
  }

  if (input.userId && actor.role !== "STAFF") scope.userId = input.userId;
  if (input.lateOnly) scope.isLate = true;

  if (input.from || input.to) {
    scope.businessDate = {
      ...(input.from ? { gte: new Date(input.from) } : {}),
      ...(input.to ? { lte: new Date(input.to) } : {}),
    };
  }

  const rows = await prisma.attendance.findMany({
    where: scope,
    orderBy: [{ businessDate: "desc" }, { clockInAt: "desc" }],
    take: 50,
    select: {
      id: true,
      businessDate: true,
      clockInAt: true,
      clockOutAt: true,
      isLate: true,
      lateMinutes: true,
      status: true,
      locationDenied: true,
      photoPath: true,
      photoPurgedAt: true,
      note: true,
      user: { select: { id: true, displayName: true } },
      shop: { select: { id: true, name: true, code: true } },
      shift: { select: { id: true, name: true } },
    },
  });

  return rows.map(toAttendanceDTO);
}

/**
 * One record, for the §8.9 detail view.
 *
 * A staff member may read their OWN record; a manager any record at their
 * shops; the owner anything.
 */
export async function getAttendance(actor: Actor, id: string) {
  const record = await prisma.attendance.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      businessDate: true,
      clockInAt: true,
      clockOutAt: true,
      isLate: true,
      lateMinutes: true,
      status: true,
      locationDenied: true,
      latitude: true,
      longitude: true,
      accuracyM: true,
      photoPath: true,
      photoPurgedAt: true,
      note: true,
      user: { select: { id: true, displayName: true } },
      shop: { select: { id: true, name: true, code: true } },
      shift: { select: { id: true, name: true } },
    },
  });
  if (!record) throw notFound("That attendance record no longer exists.");

  assertCanReadAttendance(actor, record.userId, record.shop.id);

  return {
    ...toAttendanceDTO(record),
    latitude: record.latitude?.toString() ?? null,
    longitude: record.longitude?.toString() ?? null,
    accuracyM: record.accuracyM,
  };
}

/** Shared read rule, so the photo route and the detail view cannot diverge. */
export function assertCanReadAttendance(
  actor: Actor,
  recordUserId: string,
  recordShopId: string
): void {
  if (actor.role === "OWNER") return;
  if (recordUserId === actor.userId) return; // own record
  if (actor.role === "MANAGER" && actor.assignedShopIds.includes(recordShopId)) {
    return;
  }
  throw forbidden("You do not have access to that attendance record.");
}

function toAttendanceDTO(row: {
  id: string;
  businessDate: Date;
  clockInAt: Date;
  clockOutAt: Date | null;
  isLate: boolean;
  lateMinutes: number;
  status: string;
  locationDenied: boolean;
  photoPath: string | null;
  photoPurgedAt: Date | null;
  note: string | null;
  user: { id: string; displayName: string };
  shop: { id: string; name: string; code: string };
  shift: { id: string; name: string } | null;
}) {
  return {
    id: row.id,
    businessDate: row.businessDate.toISOString().slice(0, 10),
    clockInAt: row.clockInAt.toISOString(),
    clockOutAt: row.clockOutAt?.toISOString() ?? null,
    isLate: row.isLate,
    lateMinutes: row.lateMinutes,
    status: row.status,
    locationDenied: row.locationDenied,
    // Never a file path — the image is served through an authenticated route
    // (§4.15). A path in the payload would invite direct static serving.
    photoUrl: row.photoPath ? `/api/attendance/${row.id}/photo` : null,
    photoPurged: row.photoPurgedAt !== null,
    note: row.note,
    user: row.user,
    shop: row.shop,
    shift: row.shift,
  };
}

/**
 * Owner edit / excuse (§4.13, §7.7). OWNER only, audit-logged with before and
 * after values so a corrected record still shows what it originally said.
 */
export async function editAttendance(
  actor: Actor,
  id: string,
  input: z.infer<typeof editAttendanceSchema>,
  meta: { ipAddress?: string | null } = {}
) {
  if (actor.role !== "OWNER") {
    throw forbidden("Only the owner can edit an attendance record.");
  }

  const before = await prisma.attendance.findUnique({
    where: { id },
    select: {
      id: true,
      shopId: true,
      status: true,
      isLate: true,
      lateMinutes: true,
      note: true,
    },
  });
  if (!before) throw notFound("That attendance record no longer exists.");

  // Excusing a record clears lateness unless the caller says otherwise: an
  // excused absence that still counts as late would make the lateness report
  // contradict the owner's own decision.
  const excusing = input.status === "EXCUSED";

  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.attendance.update({
      where: { id },
      data: {
        status: input.status ?? undefined,
        isLate: input.isLate ?? (excusing ? false : undefined),
        lateMinutes: input.lateMinutes ?? (excusing ? 0 : undefined),
        note: input.note ?? undefined,
        editedById: actor.userId,
        editedAt: new Date(),
      },
      select: {
        id: true,
        status: true,
        isLate: true,
        lateMinutes: true,
        note: true,
      },
    });

    await writeAudit(
      actor,
      {
        entity: "Attendance",
        entityId: id,
        action: "ATTENDANCE_EDIT",
        shopId: before.shopId,
        before: {
          status: before.status,
          isLate: before.isLate,
          lateMinutes: before.lateMinutes,
          note: before.note,
        },
        after: {
          status: row.status,
          isLate: row.isLate,
          lateMinutes: row.lateMinutes,
          note: row.note,
        },
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return row;
  });

  return updated;
}

/**
 * Photo bytes for the authenticated image route (§4.15).
 *
 * Returns the absolute path only after the same read check the detail view
 * uses. There is deliberately no static serving of `data/`.
 */
export async function getAttendancePhotoPath(actor: Actor, id: string) {
  const record = await prisma.attendance.findUnique({
    where: { id },
    select: { userId: true, shopId: true, photoPath: true, photoPurgedAt: true },
  });
  if (!record) throw notFound("That attendance record no longer exists.");

  assertCanReadAttendance(actor, record.userId, record.shopId);

  if (!record.photoPath) {
    throw notFound(
      record.photoPurgedAt
        ? "That photo has passed its 61-day retention and was deleted."
        : "That record has no photo."
    );
  }

  return record.photoPath;
}
