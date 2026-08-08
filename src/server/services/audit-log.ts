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
import type { Actor } from "@/server/auth/context";
import { forbidden } from "@/server/errors";
import { z } from "zod";

export const listAuditLogSchema = z.object({
  entity: z.string().max(64).optional(),
  action: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
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
const DEFAULT_LIMIT = 50;

export async function listAuditLog(
  actor: Actor,
  input: ListAuditLogInput = {}
): Promise<{ rows: AuditLogRow[]; nextCursor: string | null }> {
  // §4.16: the audit log is the owner's oversight tool. A manager reading it
  // would see every other branch's activity, and a staff member would see the
  // record of checks made on them — both outside §3.4's grants.
  if (actor.role !== "OWNER") {
    throw forbidden("Only the owner can read the audit log.");
  }

  const take = input.limit ?? DEFAULT_LIMIT;

  const rows = await prisma.auditLog.findMany({
    where: {
      ...(input.entity ? { entity: input.entity } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.userId ? { userId: input.userId } : {}),
    },
    orderBy: { occurredAt: "desc" },
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
  if (actor.role !== "OWNER") {
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
