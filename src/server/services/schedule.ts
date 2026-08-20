/**
 * The staff timetable (PRD §4.14.1).
 *
 * `Shift` says when a SHOP is open and who could be late. This file says which
 * PERSON is expected on which shift on which day — the thing that turns a list
 * of shop opening hours into a roster.
 *
 * Two layers, deliberately:
 *
 *   1. **`ScheduleAssignment`** — the recurring pattern. "Budi works Mon-Wed on
 *      PIK's morning shift, from 1 September." One row, repeating forever.
 *   2. **`ScheduleOverride`** — a single-date exception. Leave, a swap, an extra
 *      body on a busy Saturday. `ADDED` or `REMOVED`, always with a reason.
 *
 * **Overrides are never edits of the pattern.** Changing next Tuesday must not
 * change every Tuesday — that is the mistake an "edit the assignment" flow
 * invites, and it silently rewrites a roster people have already planned
 * around. `resolveDay` composes the two at read time instead.
 *
 * ## What this file does NOT do
 *
 * It does not decide whether someone MAY clock in. Being unscheduled is not a
 * permission failure — a staff member covering for a colleague at short notice
 * must be able to clock in, and §4.14.1 records that as `COVER` with a reason
 * rather than blocking it. Shop ACCESS is still `assertShopAccess`; the
 * timetable only decides whether the app GREETS them with a clock-in prompt.
 * Conflating the two would leave a branch unable to open because the roster was
 * not updated.
 */
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

/** `HH:MM` of a `@db.Time`, which Prisma returns as a Date on 1970-01-01 UTC. */
function formatTime(time: Date): string {
  return `${String(time.getUTCHours()).padStart(2, "0")}:${String(
    time.getUTCMinutes()
  ).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` → the UTC-midnight Date a Postgres DATE column holds. */
function toBusinessDate(value: string): Date {
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-01.");

export const assignmentSchema = z.object({
  userId: z.string().min(1),
  shiftId: z.string().min(1),
  /** 0 = Sunday, matching `Shift.daysOfWeek`. Sunday off = Sunday omitted. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  /**
   * When this pattern starts. Optional to the CALLER — the form does not ask
   * for it and the service defaults to today (D-140). It is still stored,
   * because "was this person scheduled last Monday?" needs an answer for dates
   * before the row existed.
   */
  effectiveFrom: dateString.optional(),
  note: z.string().trim().max(200).optional(),
});

export const updateAssignmentSchema = assignmentSchema
  .omit({ userId: true, shiftId: true })
  .partial();

/** Approved absence over a date range (§4.14.2). */
export const leaveSchema = z
  .object({
    userId: z.string().min(1),
    /** Null/absent = every branch this person works at, which is the norm. */
    shopId: z.string().min(1).nullish(),
    startDate: dateString,
    endDate: dateString,
    reason: z.string().trim().min(3).max(200),
  })
  .refine((v) => v.endDate >= v.startDate, {
    message: "Leave cannot end before it starts.",
    path: ["endDate"],
  });

export const overrideSchema = z.object({
  userId: z.string().min(1),
  shiftId: z.string().min(1),
  businessDate: dateString,
  kind: z.enum(["ADDED", "REMOVED"]),
  /**
   * Required, and not merely non-empty. An override is always somebody's
   * decision, and "why was the roster different that week?" is the question the
   * owner actually asks — a blank reason makes the row unable to answer it.
   */
  reason: z.string().trim().min(3).max(200),
});

/** §3.4, mirroring `shifts.ts`: owner, or a MANAGER at this specific shop. */
function assertCanManageSchedule(actor: Actor, shopId: string): void {
  if (actor.isOwner) return;
  if (actor.shopRoles.get(shopId)?.role !== "MANAGER") {
    throw forbidden("Only a manager or the owner can change the timetable.");
  }
}

/**
 * A person must already be assigned to the shop before they can be rostered
 * there.
 *
 * `UserShop` is the access fact; the timetable is a planning layer on top of
 * it. Rostering someone at a branch they cannot reach would produce a roster
 * that looks staffed and a person who gets a 403 on arrival — worse than an
 * empty cell, because nobody goes looking for it.
 */
async function assertRosterable(userId: string, shopId: string): Promise<void> {
  const [user, link] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, banned: true, displayName: true },
    }),
    prisma.userShop.findUnique({
      where: { userId_shopId: { userId, shopId } },
      select: { role: true },
    }),
  ]);

  if (!user) throw notFound("That employee no longer exists.");
  if (user.banned) {
    throw new AppError(
      "VALIDATION_FAILED",
      "That employee is deactivated and cannot be added to the timetable."
    );
  }
  if (!link) {
    throw new AppError(
      "VALIDATION_FAILED",
      "That employee is not assigned to this branch. Add them under Staff first."
    );
  }
}

/**
 * The shift, checked to belong to this shop.
 *
 * Passing a shift id from another branch is the obvious way to try to roster
 * across a boundary, so this is a real check rather than a convenience lookup.
 */
async function shiftAtShop(shiftId: string, shopId: string) {
  const shift = await prisma.shift.findFirst({
    where: { id: shiftId, shopId },
    select: {
      id: true,
      name: true,
      shopId: true,
      startTime: true,
      endTime: true,
      daysOfWeek: true,
      isActive: true,
    },
  });
  if (!shift) throw notFound("That shift is not available at this branch.");
  return shift;
}

// ─────────────────────────── assignments ───────────────────────────

export async function listAssignments(
  actor: Actor,
  shopId: string,
  opts: { includeRemoved?: boolean } = {}
) {
  assertShopAccess(actor, shopId);

  const rows = await prisma.scheduleAssignment.findMany({
    where: {
      shopId,
      // Removed patterns are hidden by default — that is the whole point of
      // Remove (D-140). They are still readable with the flag, for the audit
      // trail behind a past lateness record.
      ...(opts.includeRemoved ? {} : { removedAt: null }),
    },
    orderBy: [{ effectiveFrom: "desc" }],
    select: {
      id: true,
      userId: true,
      shopId: true,
      shiftId: true,
      daysOfWeek: true,
      effectiveFrom: true,
      removedAt: true,
      note: true,
      user: { select: { displayName: true, username: true } },
      shift: { select: { name: true, startTime: true, endTime: true, isActive: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    shopId: r.shopId,
    shiftId: r.shiftId,
    employeeName: r.user.displayName,
    username: r.user.username,
    shiftName: r.shift.name,
    startTime: formatTime(r.shift.startTime),
    endTime: formatTime(r.shift.endTime),
    shiftIsActive: r.shift.isActive,
    daysOfWeek: [...r.daysOfWeek].sort((a, b) => a - b),
    effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
    /** Soft-deleted — hidden from the roster, kept for the record (D-140). */
    isRemoved: r.removedAt !== null,
    note: r.note,
  }));
}

export async function createAssignment(
  actor: Actor,
  shopId: string,
  input: z.infer<typeof assignmentSchema>
) {
  assertCanManageSchedule(actor, shopId);

  const shift = await shiftAtShop(input.shiftId, shopId);
  await assertRosterable(input.userId, shopId);

  // Defaults to today: the form does not ask, because a start date is
  // bookkeeping the owner should not have to think about (D-140).
  const from = input.effectiveFrom
    ? toBusinessDate(input.effectiveFrom)
    : actor.businessDate;

  // The assignment selects from within the shift's operating days; it never
  // extends them. Rostering someone on a day the branch does not run this
  // shift would put a name on the timetable for a day nobody is there.
  const outside = input.daysOfWeek.filter((d) => !shift.daysOfWeek.includes(d));
  if (outside.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `${shift.name} does not run on ${outside
        .map((d) => DAY_NAMES[d])
        .join(", ")}. Change the shift's days first if that is wrong.`
    );
  }

  const created = await prisma.scheduleAssignment.create({
    data: {
      userId: input.userId,
      shopId,
      shiftId: input.shiftId,
      daysOfWeek: [...new Set(input.daysOfWeek)].sort((a, b) => a - b),
      effectiveFrom: from,
      note: input.note ?? null,
      createdById: actor.userId,
    },
    select: { id: true },
  });

  await writeAudit(actor, {
    entity: "ScheduleAssignment",
    entityId: created.id,
    action: "SCHEDULE_ASSIGN",
    shopId,
    after: {
      userId: input.userId,
      shiftId: input.shiftId,
      daysOfWeek: input.daysOfWeek,
      effectiveFrom: from.toISOString().slice(0, 10),
    },
  });

  return { id: created.id };
}

export async function updateAssignment(
  actor: Actor,
  assignmentId: string,
  input: z.infer<typeof updateAssignmentSchema>
) {
  const existing = await prisma.scheduleAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      shopId: true,
      shiftId: true,
      userId: true,
      daysOfWeek: true,
      effectiveFrom: true,
    },
  });
  if (!existing) throw notFound("That timetable entry no longer exists.");

  assertCanManageSchedule(actor, existing.shopId);

  const shift = await shiftAtShop(existing.shiftId, existing.shopId);

  const days = input.daysOfWeek ?? existing.daysOfWeek;
  const outside = days.filter((d) => !shift.daysOfWeek.includes(d));
  if (outside.length > 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      `${shift.name} does not run on ${outside
        .map((d) => DAY_NAMES[d])
        .join(", ")}. Change the shift's days first if that is wrong.`
    );
  }

  const from = input.effectiveFrom
    ? toBusinessDate(input.effectiveFrom)
    : existing.effectiveFrom;

  await prisma.scheduleAssignment.update({
    where: { id: assignmentId },
    data: {
      daysOfWeek: [...new Set(days)].sort((a, b) => a - b),
      effectiveFrom: from,
      note: input.note ?? undefined,
    },
  });

  await writeAudit(actor, {
    entity: "ScheduleAssignment",
    entityId: assignmentId,
    action: "SCHEDULE_ASSIGN_UPDATE",
    shopId: existing.shopId,
    before: {
      daysOfWeek: existing.daysOfWeek,
      effectiveFrom: existing.effectiveFrom.toISOString().slice(0, 10),
    },
    after: {
      daysOfWeek: days,
      effectiveFrom: from.toISOString().slice(0, 10),
    },
  });

  return { id: assignmentId };
}

/**
 * Remove a schedule — the person no longer works this shift (§4.14.1, D-140).
 *
 * **A soft delete.** The row is hidden from the roster, from `resolveDay` and
 * from the clock-in prompt, but it is not destroyed. `Attendance` has no
 * foreign key to this table, so a hard delete would break nothing structurally
 * — what it would destroy is the evidence behind a past record. An attendance
 * row reading `SCHEDULED, 440 minutes late` only means something because a
 * schedule put that person on a shift starting at a particular time, and a
 * lateness figure is a wage conversation (§4.13).
 *
 * The owner asked for exactly this split: no clutter on screen, every late
 * record still intact behind it.
 *
 * **This is not the tool for a holiday.** Temporary absence is `ScheduleLeave`,
 * which suppresses the clock-in prompt for a date range and then resumes on its
 * own. Removing and re-adding a pattern for a fortnight's leave loses the
 * pattern's own history and leaves the days after the return unrostered.
 */
export async function removeAssignment(actor: Actor, assignmentId: string) {
  const existing = await prisma.scheduleAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      shopId: true,
      userId: true,
      shiftId: true,
      daysOfWeek: true,
      removedAt: true,
    },
  });
  if (!existing) throw notFound("That timetable entry no longer exists.");

  assertCanManageSchedule(actor, existing.shopId);

  if (existing.removedAt !== null) {
    throw new AppError(
      "VALIDATION_FAILED",
      "That schedule has already been removed."
    );
  }

  await prisma.scheduleAssignment.update({
    where: { id: assignmentId },
    data: { removedAt: new Date(), removedById: actor.userId },
  });

  await writeAudit(actor, {
    entity: "ScheduleAssignment",
    entityId: assignmentId,
    action: "SCHEDULE_ASSIGN_REMOVE",
    shopId: existing.shopId,
    before: {
      userId: existing.userId,
      shiftId: existing.shiftId,
      daysOfWeek: existing.daysOfWeek,
    },
  });

  return { id: assignmentId, removed: true };
}

/**
 * Undo a removal (§4.14.1, D-140).
 *
 * Exists because Remove is otherwise irreversible from the UI, and a mis-tap on
 * a destructive control should not cost the owner a retyped pattern. Re-checks
 * that the shift is still active and the person still works here, so a schedule
 * cannot come back pointing at something that no longer exists.
 */
export async function restoreAssignment(actor: Actor, assignmentId: string) {
  const existing = await prisma.scheduleAssignment.findUnique({
    where: { id: assignmentId },
    select: {
      id: true,
      shopId: true,
      shiftId: true,
      userId: true,
      removedAt: true,
    },
  });
  if (!existing) throw notFound("That timetable entry no longer exists.");

  assertCanManageSchedule(actor, existing.shopId);

  if (existing.removedAt === null) {
    throw new AppError("VALIDATION_FAILED", "That schedule is not removed.");
  }

  const shift = await shiftAtShop(existing.shiftId, existing.shopId);
  if (!shift.isActive) {
    throw new AppError(
      "VALIDATION_FAILED",
      `${shift.name} has been retired. Reactivate the shift first, or add a new schedule.`
    );
  }
  await assertRosterable(existing.userId, existing.shopId);

  await prisma.scheduleAssignment.update({
    where: { id: assignmentId },
    data: { removedAt: null, removedById: null },
  });

  await writeAudit(actor, {
    entity: "ScheduleAssignment",
    entityId: assignmentId,
    action: "SCHEDULE_ASSIGN_RESTORE",
    shopId: existing.shopId,
    after: { userId: existing.userId },
  });

  return { id: assignmentId, restored: true };
}

// ─────────────────────────── overrides ───────────────────────────

export async function createOverride(
  actor: Actor,
  shopId: string,
  input: z.infer<typeof overrideSchema>
) {
  assertCanManageSchedule(actor, shopId);

  await shiftAtShop(input.shiftId, shopId);
  await assertRosterable(input.userId, shopId);

  const businessDate = toBusinessDate(input.businessDate);

  // A second decision about the same person, shift and date replaces the first
  // rather than stacking a contradictory pair.
  const row = await prisma.scheduleOverride.upsert({
    where: {
      userId_shiftId_businessDate: {
        userId: input.userId,
        shiftId: input.shiftId,
        businessDate,
      },
    },
    create: {
      userId: input.userId,
      shopId,
      shiftId: input.shiftId,
      businessDate,
      kind: input.kind,
      reason: input.reason,
      createdById: actor.userId,
    },
    update: {
      kind: input.kind,
      reason: input.reason,
      createdById: actor.userId,
    },
    select: { id: true },
  });

  await writeAudit(actor, {
    entity: "ScheduleOverride",
    entityId: row.id,
    action: "SCHEDULE_OVERRIDE",
    shopId,
    after: {
      userId: input.userId,
      shiftId: input.shiftId,
      businessDate: input.businessDate,
      kind: input.kind,
      reason: input.reason,
    },
  });

  return { id: row.id };
}

export async function deleteOverride(actor: Actor, overrideId: string) {
  const existing = await prisma.scheduleOverride.findUnique({
    where: { id: overrideId },
    select: { id: true, shopId: true, userId: true, kind: true },
  });
  if (!existing) throw notFound("That timetable change no longer exists.");

  assertCanManageSchedule(actor, existing.shopId);

  await prisma.scheduleOverride.delete({ where: { id: overrideId } });

  await writeAudit(actor, {
    entity: "ScheduleOverride",
    entityId: overrideId,
    action: "SCHEDULE_OVERRIDE_DELETE",
    shopId: existing.shopId,
    before: { userId: existing.userId, kind: existing.kind },
  });

  return { id: overrideId };
}

// ─────────────────────────── leave ───────────────────────────

/**
 * Grant leave over a date range (§4.14.2, D-140).
 *
 * Replaces what the owner was reaching for when they used End: a temporary
 * absence that ends by itself. The schedule is untouched, so the person simply
 * resumes when the range is over — nothing to remember to switch back on.
 */
export async function createLeave(
  actor: Actor,
  input: z.infer<typeof leaveSchema>
) {
  // Leave is granted by someone who manages a branch this person works at.
  // With no shopId it is business-wide, so the check is "manages ANY shop this
  // person is assigned to" — an owner passes trivially.
  const links = await prisma.userShop.findMany({
    where: { userId: input.userId },
    select: { shopId: true },
  });
  if (links.length === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "That employee is not assigned to any branch."
    );
  }

  if (input.shopId) {
    assertCanManageSchedule(actor, input.shopId);
    if (!links.some((l) => l.shopId === input.shopId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "That employee does not work at this branch."
      );
    }
  } else if (!actor.isOwner) {
    const managesOne = links.some(
      (l) => actor.shopRoles.get(l.shopId)?.role === "MANAGER"
    );
    if (!managesOne) {
      throw forbidden("Only a manager or the owner can record leave.");
    }
  }

  const start = toBusinessDate(input.startDate);
  const end = toBusinessDate(input.endDate);

  const row = await prisma.scheduleLeave.create({
    data: {
      userId: input.userId,
      shopId: input.shopId ?? null,
      startDate: start,
      endDate: end,
      reason: input.reason,
      createdById: actor.userId,
    },
    select: { id: true },
  });

  await writeAudit(actor, {
    entity: "ScheduleLeave",
    entityId: row.id,
    action: "SCHEDULE_LEAVE_CREATE",
    shopId: input.shopId ?? null,
    after: {
      userId: input.userId,
      startDate: input.startDate,
      endDate: input.endDate,
      reason: input.reason,
    },
  });

  return { id: row.id };
}

/** Cancel a leave period. The schedule resumes for those dates. */
export async function cancelLeave(actor: Actor, leaveId: string) {
  const existing = await prisma.scheduleLeave.findUnique({
    where: { id: leaveId },
    select: {
      id: true,
      userId: true,
      shopId: true,
      startDate: true,
      endDate: true,
    },
  });
  if (!existing) throw notFound("That leave record no longer exists.");

  if (existing.shopId) {
    assertCanManageSchedule(actor, existing.shopId);
  } else if (!actor.isOwner) {
    const links = await prisma.userShop.findMany({
      where: { userId: existing.userId },
      select: { shopId: true },
    });
    const managesOne = links.some(
      (l) => actor.shopRoles.get(l.shopId)?.role === "MANAGER"
    );
    if (!managesOne) {
      throw forbidden("Only a manager or the owner can cancel leave.");
    }
  }

  await prisma.scheduleLeave.delete({ where: { id: leaveId } });

  await writeAudit(actor, {
    entity: "ScheduleLeave",
    entityId: leaveId,
    action: "SCHEDULE_LEAVE_CANCEL",
    shopId: existing.shopId,
    before: {
      userId: existing.userId,
      startDate: existing.startDate.toISOString().slice(0, 10),
      endDate: existing.endDate.toISOString().slice(0, 10),
    },
  });

  return { id: leaveId, cancelled: true };
}

/**
 * Leave records touching a shop, for the roster screen.
 *
 * Includes business-wide leave (`shopId: null`), because somebody on holiday is
 * absent from this branch too — showing only branch-scoped rows would hide the
 * common case entirely.
 */
export async function listLeave(
  actor: Actor,
  shopId: string,
  opts: { from?: string; to?: string } = {}
) {
  assertShopAccess(actor, shopId);

  const staff = await prisma.userShop.findMany({
    where: { shopId },
    select: { userId: true },
  });
  const userIds = staff.map((s) => s.userId);

  const rows = await prisma.scheduleLeave.findMany({
    where: {
      userId: { in: userIds },
      OR: [{ shopId: null }, { shopId }],
      // Past leave is history; the screen shows what is current or upcoming
      // unless asked for a specific window.
      ...(opts.to ? { startDate: { lte: toBusinessDate(opts.to) } } : {}),
      endDate: { gte: opts.from ? toBusinessDate(opts.from) : actor.businessDate },
    },
    orderBy: { startDate: "asc" },
    select: {
      id: true,
      userId: true,
      shopId: true,
      startDate: true,
      endDate: true,
      reason: true,
      user: { select: { displayName: true } },
    },
  });

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    employeeName: r.user.displayName,
    shopId: r.shopId,
    startDate: r.startDate.toISOString().slice(0, 10),
    endDate: r.endDate.toISOString().slice(0, 10),
    reason: r.reason,
    /** Whether it covers today, so the UI can mark it live rather than upcoming. */
    isActiveToday:
      r.startDate <= actor.businessDate && r.endDate >= actor.businessDate,
  }));
}

/** Is this person on leave on this date, and why? Null when they are not. */
export async function leaveFor(
  userId: string,
  shopId: string,
  businessDate: Date
): Promise<{ reason: string; endDate: string } | null> {
  const row = await prisma.scheduleLeave.findFirst({
    where: {
      userId,
      startDate: { lte: businessDate },
      endDate: { gte: businessDate },
      OR: [{ shopId: null }, { shopId }],
    },
    select: { reason: true, endDate: true },
  });

  return row
    ? { reason: row.reason, endDate: row.endDate.toISOString().slice(0, 10) }
    : null;
}

// ─────────────────────────── the resolver ───────────────────────────

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export interface ResolvedSlot {
  userId: string;
  employeeName: string;
  shiftId: string;
  shiftName: string;
  startTime: string;
  endTime: string;
  /** Why they are on the roster — a pattern, or a per-date addition. */
  via: "PATTERN" | "OVERRIDE";
  /** Present only for an `ADDED` override: the reason the manager gave. */
  reason: string | null;
}

/**
 * Who is rostered at a shop on one business date.
 *
 * Pattern first, then overrides applied on top: `REMOVED` takes a person off a
 * shift the pattern placed them on, `ADDED` puts them on one it did not.
 *
 * **`REMOVED` is applied after `ADDED` is collected, and both are keyed on
 * (user, shift).** A person removed from the morning shift is still rostered
 * for the evening one if the pattern says so — leave for a whole day is two
 * override rows, not one, which is why the unique key includes `shiftId`.
 */
export async function resolveDay(
  actor: Actor,
  shopId: string,
  businessDate: Date
): Promise<ResolvedSlot[]> {
  assertShopAccess(actor, shopId);

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true },
  });
  if (!shop) throw notFound("That branch no longer exists.");

  // The weekday of the BUSINESS date, read from the date itself rather than
  // from `now`. Resolving next Tuesday must not depend on what day it is today,
  // and the business date is already a UTC-midnight DATE, so UTC is correct
  // here — converting it through a timezone would shift it a day.
  const weekday = businessDate.getUTCDay();

  const [assignments, overrides, leave] = await Promise.all([
    prisma.scheduleAssignment.findMany({
      where: {
        shopId,
        effectiveFrom: { lte: businessDate },
        // Removed schedules never roster anyone. They are kept only as the
        // record behind past attendance (D-140).
        removedAt: null,
        daysOfWeek: { has: weekday },
        shift: { isActive: true },
      },
      select: {
        userId: true,
        shiftId: true,
        user: { select: { displayName: true, banned: true } },
        shift: {
          select: { name: true, startTime: true, endTime: true, daysOfWeek: true },
        },
      },
    }),
    prisma.scheduleOverride.findMany({
      where: { shopId, businessDate },
      select: {
        userId: true,
        shiftId: true,
        kind: true,
        reason: true,
        user: { select: { displayName: true, banned: true } },
        shift: {
          select: { name: true, startTime: true, endTime: true, isActive: true },
        },
      },
    }),
    /**
     * Leave covering this date (§4.14.2).
     *
     * `shopId: null` means leave from the whole business, which is the normal
     * case — somebody on holiday is away from every branch, not just one.
     */
    prisma.scheduleLeave.findMany({
      where: {
        startDate: { lte: businessDate },
        endDate: { gte: businessDate },
        OR: [{ shopId: null }, { shopId }],
      },
      select: { userId: true, reason: true },
    }),
  ]);

  // Applied AFTER overrides below, so an explicit "come in on this date"
  // override does NOT silently beat approved leave — leave wins, and the
  // manager has to cancel the leave rather than working around it.
  const onLeave = new Map(leave.map((l) => [l.userId, l.reason]));

  const key = (userId: string, shiftId: string) => `${userId}:${shiftId}`;
  const slots = new Map<string, ResolvedSlot>();

  for (const a of assignments) {
    // The shift's own days are re-checked here as well as in the query: a shift
    // edited to drop a day must stop rostering people on it immediately, and an
    // assignment created before that edit still carries the old day.
    if (!a.shift.daysOfWeek.includes(weekday)) continue;
    if (a.user.banned) continue;

    slots.set(key(a.userId, a.shiftId), {
      userId: a.userId,
      employeeName: a.user.displayName,
      shiftId: a.shiftId,
      shiftName: a.shift.name,
      startTime: formatTime(a.shift.startTime),
      endTime: formatTime(a.shift.endTime),
      via: "PATTERN",
      reason: null,
    });
  }

  for (const o of overrides) {
    const k = key(o.userId, o.shiftId);

    if (o.kind === "REMOVED") {
      slots.delete(k);
      continue;
    }

    if (o.user.banned || !o.shift.isActive) continue;

    slots.set(k, {
      userId: o.userId,
      employeeName: o.user.displayName,
      shiftId: o.shiftId,
      shiftName: o.shift.name,
      startTime: formatTime(o.shift.startTime),
      endTime: formatTime(o.shift.endTime),
      via: "OVERRIDE",
      reason: o.reason,
    });
  }

  /**
   * Leave last, so it beats both the pattern and any ADDED override.
   *
   * Deliberate: approved leave is a decision about the PERSON, and an override
   * saying "put them on Tuesday" made before the leave was granted must not
   * quietly cancel it. To bring somebody in during their leave, cancel the
   * leave — which leaves a record — rather than layering an override on top,
   * which would not.
   */
  for (const [userId] of onLeave) {
    for (const [k, v] of slots) {
      if (v.userId === userId) slots.delete(k);
    }
  }

  return [...slots.values()].sort(
    (a, b) =>
      a.startTime.localeCompare(b.startTime) ||
      a.employeeName.localeCompare(b.employeeName)
  );
}

/**
 * What THIS person is scheduled for, at this shop, today — the question the
 * clock-in banner and the clock-in screen both ask.
 *
 * Returns every shift they are rostered for today (a split shift is two), each
 * annotated with whether clocking in right now would be late. `scheduled` being
 * false is the "not your day" case: the banner stays quiet and the clock-in
 * screen offers cover instead of a plain shift list.
 */
export async function myScheduleToday(actor: Actor, shopId: string) {
  assertShopAccess(actor, shopId);

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { timezone: true, lateGraceMin: true },
  });
  if (!shop) throw notFound("That branch no longer exists.");

  const [slots, onLeave] = await Promise.all([
    resolveDay(actor, shopId, actor.businessDate).then((all) =>
      all.filter((s) => s.userId === actor.userId)
    ),
    leaveFor(actor.userId, shopId, actor.businessDate),
  ]);

  const now = new Date();
  const { hour, minute } = localParts(now, shop.timezone);
  const nowMin = minutesFromMidnight(hour, minute);

  return {
    scheduled: slots.length > 0,
    /**
     * On approved leave today (§4.14.2). `resolveDay` has already emptied
     * `slots`, so this is what lets the clock-in screen say WHY they are not
     * being prompted rather than showing an unexplained blank.
     */
    onLeave,
    businessDate: actor.businessDate.toISOString().slice(0, 10),
    slots: slots.map((s) => {
      const [sh, sm] = s.startTime.split(":").map(Number) as [number, number];
      const [eh, em] = s.endTime.split(":").map(Number) as [number, number];
      const startMin = minutesFromMidnight(sh, sm);
      const endMin = minutesFromMidnight(eh, em);

      const { isLate, lateMinutes } = computeLateness({
        shiftStartMin: startMin,
        clockInMin: nowMin,
        clockInDayOffset: clockInDayOffsetFor(startMin, endMin, nowMin),
        graceMin: shop.lateGraceMin,
      });

      return {
        shiftId: s.shiftId,
        shiftName: s.shiftName,
        startTime: s.startTime,
        endTime: s.endTime,
        via: s.via,
        reason: s.reason,
        wouldBeLate: isLate,
        wouldBeLateMinutes: lateMinutes,
      };
    }),
  };
}

/**
 * The week grid for the roster screen: seven resolved days from a Monday.
 *
 * Read-only and derived — there is no stored "week" anywhere, which is what
 * keeps the pattern the single source of truth.
 */
export async function resolveWeek(
  actor: Actor,
  shopId: string,
  startDate: string
) {
  assertShopAccess(actor, shopId);

  const start = toBusinessDate(startDate);
  const days: { businessDate: string; weekday: number; slots: ResolvedSlot[] }[] =
    [];

  for (let i = 0; i < 7; i++) {
    const date = new Date(start.getTime() + i * 86_400_000);
    days.push({
      businessDate: date.toISOString().slice(0, 10),
      weekday: date.getUTCDay(),
      slots: await resolveDay(actor, shopId, date),
    });
  }

  return { shopId, startDate, days };
}
