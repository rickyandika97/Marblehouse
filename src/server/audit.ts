/**
 * Audit log (PRD §4.16).
 *
 * Immutable. Audit rows are never editable or deletable through the
 * application — there is deliberately no update or delete helper in this file.
 *
 * Phase 1 writes: user create / role change / shop-access change / password
 * reset, and work-session shop change (§4.7).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/server/auth/context";

/** Accepts a transaction client so an audit row commits with what it describes. */
type Db = PrismaClient | Prisma.TransactionClient;

export interface AuditInput {
  entity: string;
  entityId?: string | null;
  action: string;
  shopId?: string | null;
  before?: Prisma.InputJsonValue | null;
  after?: Prisma.InputJsonValue | null;
  reason?: string | null;
  ipAddress?: string | null;
}

/**
 * Write an audit row.
 *
 * Pass the transaction client whenever the audited change is itself
 * transactional — an audit row that survives a rolled-back change is a lie.
 */
export async function writeAudit(
  actor: Actor,
  input: AuditInput,
  db: Db = prisma
): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: actor.userId,
      role: actor.role,
      shopId: input.shopId ?? actor.workSession?.shopId ?? null,
      entity: input.entity,
      entityId: input.entityId ?? null,
      action: input.action,
      before: input.before ?? undefined,
      after: input.after ?? undefined,
      reason: input.reason ?? null,
      ipAddress: input.ipAddress ?? null,
    },
  });
}
