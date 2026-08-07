/**
 * Shift configuration (PRD §4.14, §7.7).
 *
 * Per shop: name, start and end time, active days. Shifts may cross midnight
 * (`endTime < startTime`), which is legitimate and must not be validated away —
 * a 22:00–06:00 night shift is the normal case for a late-closing branch.
 *
 * **Editing a shift never rewrites past lateness.** Attendance rows snapshot
 * `shiftStartAtCapture` and `graceMinAtCapture` at clock-in (§4.14), so there
 * is deliberately no recomputation here. A manager fixing a typo in a shift
 * time must not silently turn last month's punctual arrivals into late ones.
 */
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import type { Actor } from "@/server/auth/context";
import { assertShopAccess } from "@/server/auth/guards";
import { AppError, forbidden, notFound } from "@/server/errors";

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const shiftSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** `HH:MM`, 24-hour, in the shop's local time. */
  startTime: z.string().regex(timePattern, "Use a 24-hour time like 09:00."),
  endTime: z.string().regex(timePattern, "Use a 24-hour time like 17:00."),
  /** 0 = Sunday. Defaults to every day (§4.14). */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  isActive: z.boolean().optional(),
});

export const updateShiftSchema = shiftSchema.partial();

/** `HH:MM` → the 1970-01-01 UTC Date that Prisma stores in a `@db.Time`. */
function toTime(value: string): Date {
  const [h, m] = value.split(":").map(Number);
  return new Date(Date.UTC(1970, 0, 1, h, m, 0));
}

function fromTime(value: Date): string {
  return `${String(value.getUTCHours()).padStart(2, "0")}:${String(
    value.getUTCMinutes()
  ).padStart(2, "0")}`;
}

function toShiftDTO(row: {
  id: string;
  shopId: string;
  name: string;
  startTime: Date;
  endTime: Date;
  daysOfWeek: number[];
  isActive: boolean;
}) {
  const startTime = fromTime(row.startTime);
  const endTime = fromTime(row.endTime);
  return {
    id: row.id,
    shopId: row.shopId,
    name: row.name,
    startTime,
    endTime,
    daysOfWeek: row.daysOfWeek,
    isActive: row.isActive,
    // Surfaced so the UI can label it rather than looking like a data error.
    crossesMidnight: endTime < startTime,
  };
}

export async function listShifts(actor: Actor, shopId: string) {
  assertShopAccess(actor, shopId);

  const shifts = await prisma.shift.findMany({
    where: { shopId },
    orderBy: [{ isActive: "desc" }, { startTime: "asc" }],
    select: {
      id: true,
      shopId: true,
      name: true,
      startTime: true,
      endTime: true,
      daysOfWeek: true,
      isActive: true,
    },
  });

  return shifts.map(toShiftDTO);
}

/** §3.4: owner, or a manager at one of their own shops. */
function assertCanManageShifts(actor: Actor, shopId: string): void {
  if (actor.role === "STAFF") {
    throw forbidden("Only a manager or the owner can configure shifts.");
  }
  assertShopAccess(actor, shopId);
}

export async function createShift(
  actor: Actor,
  shopId: string,
  input: z.infer<typeof shiftSchema>
) {
  assertCanManageShifts(actor, shopId);

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true },
  });
  if (!shop) throw notFound("That branch no longer exists.");

  if (input.startTime === input.endTime) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A shift cannot start and end at the same time."
    );
  }

  const shift = await prisma.shift.create({
    data: {
      shopId,
      name: input.name,
      startTime: toTime(input.startTime),
      endTime: toTime(input.endTime),
      daysOfWeek: input.daysOfWeek ?? [0, 1, 2, 3, 4, 5, 6],
      isActive: input.isActive ?? true,
    },
    select: {
      id: true,
      shopId: true,
      name: true,
      startTime: true,
      endTime: true,
      daysOfWeek: true,
      isActive: true,
    },
  });

  await writeAudit(actor, {
    entity: "Shift",
    entityId: shift.id,
    action: "SHIFT_CREATE",
    shopId,
    after: { name: input.name, startTime: input.startTime, endTime: input.endTime },
  });

  return toShiftDTO(shift);
}

export async function updateShift(
  actor: Actor,
  shiftId: string,
  input: z.infer<typeof updateShiftSchema>
) {
  const existing = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: {
      id: true,
      shopId: true,
      name: true,
      startTime: true,
      endTime: true,
      daysOfWeek: true,
      isActive: true,
    },
  });
  if (!existing) throw notFound("That shift no longer exists.");

  assertCanManageShifts(actor, existing.shopId);

  const nextStart = input.startTime ?? fromTime(existing.startTime);
  const nextEnd = input.endTime ?? fromTime(existing.endTime);
  if (nextStart === nextEnd) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A shift cannot start and end at the same time."
    );
  }

  const updated = await prisma.shift.update({
    where: { id: shiftId },
    data: {
      name: input.name ?? undefined,
      startTime: input.startTime ? toTime(input.startTime) : undefined,
      endTime: input.endTime ? toTime(input.endTime) : undefined,
      daysOfWeek: input.daysOfWeek ?? undefined,
      isActive: input.isActive ?? undefined,
    },
    select: {
      id: true,
      shopId: true,
      name: true,
      startTime: true,
      endTime: true,
      daysOfWeek: true,
      isActive: true,
    },
  });

  // §4.14: past attendance is NOT recomputed. The snapshot on each row is the
  // historical truth; changing a shift only affects clock-ins from now on.
  await writeAudit(actor, {
    entity: "Shift",
    entityId: shiftId,
    action: "SHIFT_UPDATE",
    shopId: existing.shopId,
    before: {
      name: existing.name,
      startTime: fromTime(existing.startTime),
      endTime: fromTime(existing.endTime),
      isActive: existing.isActive,
    },
    after: {
      name: updated.name,
      startTime: fromTime(updated.startTime),
      endTime: fromTime(updated.endTime),
      isActive: updated.isActive,
    },
  });

  return toShiftDTO(updated);
}

/**
 * Deactivate a shift.
 *
 * Never a hard delete when attendance references it — the historical records
 * must keep resolving their shift name. A shift with no attendance at all can
 * be removed outright, which keeps a mistyped shift from cluttering the list
 * forever.
 */
export async function deleteShift(actor: Actor, shiftId: string) {
  const existing = await prisma.shift.findUnique({
    where: { id: shiftId },
    select: { id: true, shopId: true, name: true },
  });
  if (!existing) throw notFound("That shift no longer exists.");

  assertCanManageShifts(actor, existing.shopId);

  const used = await prisma.attendance.count({ where: { shiftId } });

  if (used > 0) {
    await prisma.shift.update({
      where: { id: shiftId },
      data: { isActive: false },
    });
  } else {
    await prisma.shift.delete({ where: { id: shiftId } });
  }

  await writeAudit(actor, {
    entity: "Shift",
    entityId: shiftId,
    action: used > 0 ? "SHIFT_DEACTIVATE" : "SHIFT_DELETE",
    shopId: existing.shopId,
    before: { name: existing.name, attendanceRows: used },
  });

  return { id: shiftId, deactivated: used > 0, deleted: used === 0 };
}
