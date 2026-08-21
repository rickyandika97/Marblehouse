/**
 * Combined balance history and ledger/cache reconciliation (PRD §4.5–4.6).
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/server/auth/context";
import { AppError, forbidden, notFound } from "@/server/errors";
import type { LedgerEntryDTO, LedgerKind } from "@/server/dto/ledger";

const PAGE_SIZE = 50;
const RECONCILE_PAGE_SIZE = 200;
const RECONCILIATION_LOCK_ID = 730_003;

type Db = PrismaClient | Prisma.TransactionClient;
export const SYSTEM_PRINCIPAL = { kind: "SYSTEM" } as const;
export type ReconciliationPrincipal = Actor | typeof SYSTEM_PRINCIPAL;

export const listLedgerSchema = z.object({
  cursor: z.string().optional(),
});

const INCLUDE = {
  shop: { select: { id: true, name: true } },
  user: { select: { id: true, displayName: true } },
} as const;

interface Cursor {
  occurredAt: string;
  kind: LedgerKind;
  id: string;
}

export async function listCustomerLedger(
  actor: Actor,
  customerId: string,
  cursorValue?: string
): Promise<{ entries: LedgerEntryDTO[]; nextCursor: string | null }> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { isActive: true, mergedIntoId: true },
  });
  if (!customer || !customer.isActive || customer.mergedIntoId) {
    throw notFound("That customer no longer exists.");
  }

  const cursor = cursorValue ? decodeCursor(cursorValue) : null;
  const occurredAt = cursor ? new Date(cursor.occurredAt) : null;

  const [marbles, tickets] = await Promise.all([
    prisma.marbleLedger.findMany({
      where: {
        customerId,
        ...(cursor && occurredAt
          ? {
              OR: [
                { occurredAt: { lt: occurredAt } },
                ...(cursor.kind === "MARBLE"
                  ? [{ occurredAt, id: { lt: cursor.id } }]
                  : [{ occurredAt }]),
              ],
            }
          : {}),
      },
      include: INCLUDE,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
    }),
    prisma.ticketLedger.findMany({
      where: {
        customerId,
        ...(cursor && occurredAt
          ? {
              OR: [
                { occurredAt: { lt: occurredAt } },
                ...(cursor.kind === "TICKET"
                  ? [{ occurredAt, id: { lt: cursor.id } }]
                  : []),
              ],
            }
          : {}),
      },
      include: INCLUDE,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: PAGE_SIZE + 1,
    }),
  ]);

  // TicketLedger keeps the exact redemption ID and its lines snapshot the
  // prize name and ticket cost, so customer history never depends on today's
  // catalog values.
  const redemptionIds = [
    ...new Set(
      tickets
        .map((entry) => entry.redemptionId)
        .filter((id): id is string => id !== null)
    ),
  ];
  const redemptions = redemptionIds.length
    ? await prisma.redemption.findMany({
        where: { id: { in: redemptionIds }, customerId },
        select: {
          id: true,
          lines: {
            select: { prizeName: true, qty: true, ticketCostTotal: true },
          },
        },
      })
    : [];
  const redeemedItemsById = new Map(
    redemptions.map((redemption) => [
      redemption.id,
      redemption.lines.map((line) => ({
        name: line.prizeName,
        qty: line.qty,
        ticketCostTotal: line.ticketCostTotal,
      })),
    ])
  );

  const combined: LedgerEntryDTO[] = [
    ...marbles.map((entry) => ({
      id: entry.id,
      kind: "MARBLE" as const,
      type: entry.type,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      businessDate: entry.businessDate.toISOString().slice(0, 10),
      occurredAt: entry.occurredAt.toISOString(),
      shop: entry.shop,
      recordedBy: entry.user,
    })),
    ...tickets.map((entry) => ({
      id: entry.id,
      kind: "TICKET" as const,
      type: entry.type,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      businessDate: entry.businessDate.toISOString().slice(0, 10),
      occurredAt: entry.occurredAt.toISOString(),
      shop: entry.shop,
      recordedBy: entry.user,
      ...(entry.redemptionId
        ? { redeemedItems: redeemedItemsById.get(entry.redemptionId) ?? [] }
        : {}),
    })),
  ].sort(compareEntries);

  const page = combined.slice(0, PAGE_SIZE);
  const last = page.at(-1);
  return {
    entries: page,
    nextCursor:
      combined.length > PAGE_SIZE && last
        ? encodeCursor({ occurredAt: last.occurredAt, kind: last.kind, id: last.id })
        : null,
  };
}

function compareEntries(a: LedgerEntryDTO, b: LedgerEntryDTO): number {
  const time = b.occurredAt.localeCompare(a.occurredAt);
  if (time !== 0) return time;
  const kind = b.kind.localeCompare(a.kind);
  return kind !== 0 ? kind : b.id.localeCompare(a.id);
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const checked = z
      .object({
        occurredAt: z.string().datetime(),
        kind: z.enum(["MARBLE", "TICKET"]),
        id: z.string().min(1),
      })
      .parse(parsed);
    return checked;
  } catch {
    throw new AppError(
      "VALIDATION_FAILED",
      "That history cursor is not valid."
    );
  }
}

export interface ReconciliationDrift {
  customerId: string;
  marbleBefore: number;
  marbleAfter: number;
  ticketBefore: number;
  ticketAfter: number;
}

export interface ReconciliationResult {
  checked: number;
  corrected: number;
  skipped: boolean;
  drifts: ReconciliationDrift[];
}

/** Run once under a Postgres transaction-scoped advisory lock. */
export async function runBalanceReconciliation(
  principal: ReconciliationPrincipal = SYSTEM_PRINCIPAL
): Promise<ReconciliationResult> {
  if ("isOwner" in principal && !principal.isOwner) {
    throw forbidden("Only the owner can reconcile customer balances.");
  }

  return prisma.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${RECONCILIATION_LOCK_ID}) AS locked
      `;
      if (!lock[0]?.locked) {
        return { checked: 0, corrected: 0, skipped: true, drifts: [] };
      }
      return reconcileInsideTransaction(principal, tx);
    },
    { timeout: 300_000 }
  );
}

async function reconcileInsideTransaction(
  principal: ReconciliationPrincipal,
  tx: Prisma.TransactionClient
): Promise<ReconciliationResult> {
  let cursor: string | undefined;
  let checked = 0;
  const drifts: ReconciliationDrift[] = [];

  while (true) {
    const customers = await tx.customer.findMany({
      where: { isActive: true, mergedIntoId: null },
      select: { id: true, marbleBalance: true, ticketBalance: true },
      orderBy: { id: "asc" },
      take: RECONCILE_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (customers.length === 0) break;

    const ids = customers.map((customer) => customer.id);
    const [marbleSums, ticketSums] = await Promise.all([
      tx.marbleLedger.groupBy({
        by: ["customerId"],
        where: { customerId: { in: ids } },
        _sum: { delta: true },
      }),
      tx.ticketLedger.groupBy({
        by: ["customerId"],
        where: { customerId: { in: ids } },
        _sum: { delta: true },
      }),
    ]);
    const marbleByCustomer = new Map(
      marbleSums.map((row) => [row.customerId, row._sum.delta ?? 0])
    );
    const ticketByCustomer = new Map(
      ticketSums.map((row) => [row.customerId, row._sum.delta ?? 0])
    );

    for (const customer of customers) {
      checked += 1;
      const marbleAfter = marbleByCustomer.get(customer.id) ?? 0;
      const ticketAfter = ticketByCustomer.get(customer.id) ?? 0;
      if (
        marbleAfter === customer.marbleBalance &&
        ticketAfter === customer.ticketBalance
      ) {
        continue;
      }

      const drift: ReconciliationDrift = {
        customerId: customer.id,
        marbleBefore: customer.marbleBalance,
        marbleAfter,
        ticketBefore: customer.ticketBalance,
        ticketAfter,
      };
      drifts.push(drift);

      await tx.customer.update({
        where: { id: customer.id },
        data: { marbleBalance: marbleAfter, ticketBalance: ticketAfter },
      });
      await recordDrift(principal, drift, tx);
    }

    cursor = customers.at(-1)?.id;
    if (customers.length < RECONCILE_PAGE_SIZE) break;
  }

  return { checked, corrected: drifts.length, skipped: false, drifts };
}

async function recordDrift(
  principal: ReconciliationPrincipal,
  drift: ReconciliationDrift,
  tx: Prisma.TransactionClient
): Promise<void> {
  const now = new Date();
  const details = drift as unknown as Prisma.InputJsonObject;
  await tx.systemAlert.upsert({
    where: { key: `BALANCE_DRIFT:${drift.customerId}` },
    update: {
      severity: "CRITICAL",
      message: "A customer balance cache disagreed with its ledger and was corrected.",
      details,
      isActive: true,
      lastSeenAt: now,
      resolvedAt: null,
    },
    create: {
      key: `BALANCE_DRIFT:${drift.customerId}`,
      severity: "CRITICAL",
      title: "Customer balance drift detected",
      message: "A customer balance cache disagreed with its ledger and was corrected.",
      details,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });

  await tx.auditLog.create({
    data: {
      userId: "isOwner" in principal ? principal.userId : null,
      // D-122: role is per-shop now, and this reconciliation touches every
      // customer's balance with no single shop in scope, so there is no
      // one shop-role to snapshot here — OWNER (the only actor who can
      // reach this) still resolves cleanly.
      role: "isOwner" in principal && principal.isOwner ? "OWNER" : null,
      entity: "Customer",
      entityId: drift.customerId,
      action: "BALANCE_RECONCILED",
      before: {
        marbleBalance: drift.marbleBefore,
        ticketBalance: drift.ticketBefore,
      },
      after: {
        marbleBalance: drift.marbleAfter,
        ticketBalance: drift.ticketAfter,
      },
      reason: "Ledger/cache drift corrected by reconciliation.",
    },
  });
}
