/**
 * Reading the audit log (PRD §4.16, §8.10).
 *
 * `src/server/audit.ts` has written these rows since Phase 1. Nothing has ever
 * read them back, which meant the trail existed but could not actually be
 * consulted — the point of an audit log is that someone looks at it.
 *
 * **Read-only, and owner-only.** There is deliberately no update or delete
 * anywhere in this file or in `audit.ts`: §4.16 requires the log to be
 * immutable, and a "tidy up old audit rows" helper is exactly how a trail stops
 * being evidence. Retention of audit rows is not implemented for the same
 * reason — they are small, and losing them is worse than keeping them.
 */
import { prisma } from "@/lib/prisma";
import { localParts } from "@/lib/business-date";
import type { Actor } from "@/server/auth/context";
import { forbidden } from "@/server/errors";
import { Prisma } from "@prisma/client";
import { z } from "zod";

export const listAuditLogSchema = z.object({
  entity: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  /** Inclusive calendar-date range in the app timezone, not UTC days. */
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  /** Searches the complete trail before pagination, including change details. */
  q: z.string().trim().max(120).optional(),
  /** Opaque continuation cursor — the id of the last row on the page. */
  cursor: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export type ListAuditLogInput = z.infer<typeof listAuditLogSchema>;

export interface AuditLogRow {
  id: string;
  occurredAt: string;
  actor: string | null;
  role: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  reason: string | null;
  shopName: string | null;
  ipAddress: string | null;
  before: unknown;
  after: unknown;
}

/** NF-4's page size. A trail is browsed, not loaded whole. */
const DEFAULT_LIMIT = 30;

/**
 * Convert an ISO calendar date to its start instant in the app timezone.
 * Audit timestamps are UTC, but an owner choosing 20 Aug expects their local
 * 20 Aug, not the UTC slice that overlaps two Jakarta calendar days.
 */
function calendarDayStart(date: string, timezone = process.env.TZ ?? "Asia/Jakarta") {
  const toInstant = (ymd: string) => {
    const [year, month, day] = ymd.split("-").map(Number) as [number, number, number];
    const guessedUtc = Date.UTC(year, month - 1, day);
    const local = localParts(new Date(guessedUtc), timezone);
    const offsetMs =
      Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) -
      guessedUtc;
    return new Date(guessedUtc - offsetMs);
  };

  return toInstant(date);
}

function nextCalendarDate(date: string) {
  const next = new Date(`${date}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export async function listAuditLog(
  actor: Actor,
  input: ListAuditLogInput = {}
): Promise<{ rows: AuditLogRow[]; nextCursor: string | null }> {
  // §4.16: the audit log is the owner's oversight tool. A manager reading it
  // would see every other branch's activity, and a staff member would see the
  // record of checks made on them — both outside §3.4's grants.
  if (!actor.isOwner) {
    throw forbidden("Only the owner can read the audit log.");
  }

  const take = input.limit ?? DEFAULT_LIMIT;
  const q = input.q?.trim();

  // Prisma's JSON filters only inspect a declared path, whereas audit detail
  // objects have intentionally varied shapes. Cast the two immutable snapshots
  // to text for a safe parameterised whole-document search, then feed their IDs
  // back into the normal paged query below.
  const matchingDetailIds = q
    ? (
        await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
          SELECT "id"
          FROM "AuditLog"
          WHERE "before"::text ILIKE ${`%${q}%`}
             OR "after"::text ILIKE ${`%${q}%`}
        `)
      ).map((row) => row.id)
    : [];

  // AuditLog deliberately stores shopId without a relation so a historical row
  // survives a renamed/deactivated shop. Find matching shops separately, then
  // include those immutable IDs in the trail search.
  const matchingShopIds = q
    ? (
        await prisma.shop.findMany({
          where: {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { code: { contains: q, mode: "insensitive" } },
            ],
          },
          select: { id: true },
        })
      ).map((shop) => shop.id)
    : [];

  const matchingRoles = q
    ? (["OWNER", "MANAGER", "STAFF"] as const).filter((role) =>
        role.includes(q.toUpperCase())
      )
    : [];

  const where: Prisma.AuditLogWhereInput = {
    ...(input.entity ? { entity: input.entity } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.from || input.to
      ? {
          occurredAt: {
            ...(input.from ? { gte: calendarDayStart(input.from) } : {}),
            ...(input.to ? { lt: calendarDayStart(nextCalendarDate(input.to)) } : {}),
          },
        }
      : {}),
    ...(q
      ? {
          OR: [
            { id: { contains: q, mode: "insensitive" } },
            { entity: { contains: q, mode: "insensitive" } },
            { action: { contains: q, mode: "insensitive" } },
            { entityId: { contains: q, mode: "insensitive" } },
            { reason: { contains: q, mode: "insensitive" } },
            { ipAddress: { contains: q, mode: "insensitive" } },
            {
              user: {
                is: {
                  OR: [
                    { displayName: { contains: q, mode: "insensitive" } },
                    { username: { contains: q, mode: "insensitive" } },
                  ],
                },
              },
            },
            ...(matchingDetailIds.length ? [{ id: { in: matchingDetailIds } }] : []),
            ...(matchingShopIds.length ? [{ shopId: { in: matchingShopIds } }] : []),
            ...(matchingRoles.length ? [{ role: { in: matchingRoles } }] : []),
          ],
        }
      : {}),
  };

  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: take + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      occurredAt: true,
      role: true,
      entity: true,
      entityId: true,
      action: true,
      reason: true,
      ipAddress: true,
      before: true,
      after: true,
      shopId: true,
      user: { select: { displayName: true, username: true } },
    },
  });

  const page = rows.slice(0, take);
  const nextCursor = rows.length > take ? (page[page.length - 1]?.id ?? null) : null;

  // `AuditLog.shopId` is a plain column with no relation (it records where the
  // action happened, and must survive a shop being renamed or deactivated).
  // Resolve names in one extra query rather than adding a relation and a
  // migration purely for a display label.
  const shopIds = [...new Set(page.map((r) => r.shopId).filter((id): id is string => Boolean(id)))];
  const shops = shopIds.length
    ? await prisma.shop.findMany({
        where: { id: { in: shopIds } },
        select: { id: true, name: true },
      })
    : [];
  const shopName = new Map(shops.map((s) => [s.id, s.name]));

  return {
    rows: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      actor: r.user?.displayName ?? r.user?.username ?? null,
      role: r.role,
      entity: r.entity,
      entityId: r.entityId,
      action: r.action,
      reason: r.reason,
      shopName: r.shopId ? (shopName.get(r.shopId) ?? null) : null,
      ipAddress: r.ipAddress,
      before: r.before,
      after: r.after,
    })),
    nextCursor,
  };
}

/** Distinct entities and actions, for the viewer's filter controls. */
export async function auditLogFilters(actor: Actor): Promise<{
  entities: string[];
  actions: string[];
}> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can read the audit log.");
  }

  const [entities, actions] = await Promise.all([
    prisma.auditLog.findMany({
      distinct: ["entity"],
      select: { entity: true },
      orderBy: { entity: "asc" },
    }),
    prisma.auditLog.findMany({
      distinct: ["action"],
      select: { action: true },
      orderBy: { action: "asc" },
    }),
  ]);

  return {
    entities: entities.map((e) => e.entity),
    actions: actions.map((a) => a.action),
  };
}
