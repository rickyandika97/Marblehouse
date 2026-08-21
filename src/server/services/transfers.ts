/**
 * Prize transfer between branches (PRD §4.10, §7.4).
 *
 * Two steps by default, because physical movement takes time. Between the two,
 * the stock belongs to NEITHER branch's on-hand figure — it is "in transit",
 * which is why dispatch consumes at source immediately rather than at receive.
 *
 *   1. Dispatch — FIFO batches are consumed at source. Status IN_TRANSIT.
 *   2. Receive  — one NEW batch per source batch consumed, preserving both the
 *                 original `unitCogs` and the original `receivedAt`.
 *
 * **Preserving `receivedAt` is load-bearing, not bookkeeping.** FIFO sorts on
 * it, so an old cheap box that moved branches must still be consumed before a
 * newer expensive one at the destination. Stamping `now()` instead would
 * silently invert the cost basis at the destination — the exact defect D-30's
 * second mutation caught in the engine, reappearing one layer up. The test
 * `preserves receivedAt so a transferred batch keeps FIFO priority` is what
 * holds this in place.
 *
 * The batch-by-batch split is recorded on `PrizeTransferLine.batchPlan` at
 * dispatch. That is the only record of where the units came from once they have
 * left the source, and it is what receive replays.
 *
 * NOTHING here recomputes FIFO or a cost average. Every consumption goes
 * through `inventory.ts` (D-29); a cancel restores through
 * `restoreConsumption`, which already refuses a second restore (D-27).
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import {
  type Actor,
  assignedShopIds,
  canSeeCostForShop,
} from "@/server/auth/context";
import { assertShopAccess } from "@/server/auth/guards";
import { AppError, forbidden, notFound } from "@/server/errors";
import { consumeFifo, restoreConsumption } from "@/server/services/inventory";

const MAX_QTY = 1_000_000;

/**
 * One consumed source batch, captured at dispatch so receive can recreate it.
 * `receivedAt` is an ISO string because this lives in a JSON column.
 */
const batchPlanEntry = z.object({
  sourceBatchId: z.string(),
  movementId: z.string(),
  qty: z.number().int().positive(),
  unitCogs: z.string(),
  receivedAt: z.string(),
  needsCosting: z.boolean(),
});

type BatchPlanEntry = z.infer<typeof batchPlanEntry>;

const batchPlan = z.array(batchPlanEntry);

export const dispatchTransferSchema = z.object({
  fromShopId: z.string().min(1),
  toShopId: z.string().min(1),
  lines: z
    .array(
      z.object({
        prizeItemId: z.string().min(1),
        qty: z.number().int().positive().max(MAX_QTY),
      }),
    )
    .min(1)
    .max(100),
  note: z.string().trim().max(500).optional(),
});

/**
 * Cancel demands a reason — owner decision, 7 Aug 2026 (D-38).
 *
 * The same shape as a sale void (§4.3): a cancel after the box has physically
 * left is the case worth a paper trail, and it is indistinguishable from a
 * mis-keyed dispatch without one.
 */
export const cancelTransferSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export const listTransfersSchema = z.object({
  shopId: z.string().min(1).optional(),
  status: z.enum(["IN_TRANSIT", "RECEIVED", "CANCELLED"]).optional(),
});

/**
 * §4.10: a manager may only transfer where BOTH shops are in their assignment
 * list. `assertShopAccess` is called for each end separately so the error names
 * the shop that was actually refused.
 */
function assertBothEnds(
  actor: Actor,
  fromShopId: string,
  toShopId: string,
): void {
  assertShopAccess(actor, fromShopId);
  assertShopAccess(actor, toShopId);
}

/**
 * Dispatch: consume at source, record the batch split, and — when the source
 * shop has `allowDirectTransfer` — land it at the destination in the same
 * transaction (§4.10).
 *
 * Direct mode reuses `applyReceive` rather than duplicating the recreation
 * logic, so both paths preserve `receivedAt` by construction. A second copy
 * would be a second place to get FIFO wrong.
 *
 * Takes a `tx` it did not open (D-10): the caller wraps this in
 * `runIdempotent` so the transfer and its idempotency key commit together.
 */
export async function dispatchTransfer(
  tx: Prisma.TransactionClient,
  actor: Actor,
  input: z.infer<typeof dispatchTransferSchema>,
  businessDate: Date,
) {
  if (input.fromShopId === input.toShopId) {
    throw new AppError(
      "VALIDATION_FAILED",
      "A transfer needs two different branches — pick a destination that is not the source.",
    );
  }

  assertBothEnds(actor, input.fromShopId, input.toShopId);

  const [fromShop, toShop] = await Promise.all([
    tx.shop.findUnique({
      where: { id: input.fromShopId },
      select: {
        id: true,
        name: true,
        isActive: true,
        allowDirectTransfer: true,
      },
    }),
    tx.shop.findUnique({
      where: { id: input.toShopId },
      select: { id: true, name: true, isActive: true, isHqPseudoShop: true },
    }),
  ]);

  if (!fromShop || !toShop)
    throw notFound("One of the branches no longer exists.");
  if (!fromShop.isActive || !toShop.isActive) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Stock cannot be transferred to or from a deactivated branch.",
    );
  }
  // HQ is expense-only (§4.12) and carries no stock.
  if (toShop.isHqPseudoShop) {
    throw new AppError(
      "VALIDATION_FAILED",
      "HQ does not hold stock, so prizes cannot be transferred to it.",
    );
  }

  // Reject a duplicated prize up front: two lines for one item would each
  // consume separately and the second could fail on stock the first just took,
  // which reads as a confusing partial failure.
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.prizeItemId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The same prize appears twice — combine the quantities into one line.",
      );
    }
    seen.add(line.prizeItemId);
  }

  const transfer = await tx.prizeTransfer.create({
    data: {
      fromShopId: input.fromShopId,
      toShopId: input.toShopId,
      status: "IN_TRANSIT",
      note: input.note ?? null,
      dispatchedById: actor.userId,
      businessDate,
    },
    select: { id: true },
  });

  for (const line of input.lines) {
    // Throws InsufficientStockError if the source cannot cover it, which rolls
    // the whole transfer back — §15.5's "no partial writes" applies here too.
    const result = await consumeFifo(tx, {
      shopId: input.fromShopId,
      prizeItemId: line.prizeItemId,
      qty: line.qty,
      type: "TRANSFER_OUT",
      businessDate,
      userId: actor.userId,
      refType: "PrizeTransfer",
      refId: transfer.id,
    });

    // Preserve each source batch's ORIGINAL receivedAt, not the consumption
    // time. This is the field the destination sorts on.
    const sourceBatches = await tx.prizeBatch.findMany({
      where: { id: { in: result.consumptions.map((c) => c.batchId) } },
      select: { id: true, receivedAt: true, needsCosting: true },
    });
    const byId = new Map(sourceBatches.map((b) => [b.id, b]));

    const plan: BatchPlanEntry[] = result.consumptions.map((c) => {
      const source = byId.get(c.batchId);
      if (!source) {
        throw new AppError(
          "CONFLICT",
          "A source batch disappeared mid-transfer; nothing was moved.",
        );
      }
      return {
        sourceBatchId: c.batchId,
        movementId: result.movement.id,
        qty: c.qty,
        unitCogs: c.unitCogs.toString(),
        receivedAt: source.receivedAt.toISOString(),
        needsCosting: source.needsCosting,
      };
    });

    await tx.prizeTransferLine.create({
      data: {
        transferId: transfer.id,
        prizeItemId: line.prizeItemId,
        qty: line.qty,
        batchPlan: plan as unknown as Prisma.InputJsonValue,
      },
    });
  }

  await writeAudit(
    actor,
    {
      shopId: input.fromShopId,
      entity: "PrizeTransfer",
      entityId: transfer.id,
      action: "TRANSFER_DISPATCH",
      after: {
        fromShopId: input.fromShopId,
        toShopId: input.toShopId,
        lines: input.lines,
        direct: fromShop.allowDirectTransfer,
      },
    },
    tx,
  );

  // §4.10: the shop setting collapses both steps for same-day, same-person
  // moves. The stock still passes through the same consume→recreate path.
  if (fromShop.allowDirectTransfer) {
    return applyReceive(tx, actor, transfer.id, businessDate, { direct: true });
  }

  return getTransfer(tx, transfer.id);
}

/**
 * Receive: recreate one destination batch per source batch consumed.
 *
 * Called by `receiveTransfer` and by direct-mode dispatch. Splitting it out is
 * what keeps `receivedAt` preservation in exactly one place.
 */
async function applyReceive(
  tx: Prisma.TransactionClient,
  actor: Actor,
  transferId: string,
  businessDate: Date,
  opts: { direct: boolean },
) {
  const transfer = await tx.prizeTransfer.findUnique({
    where: { id: transferId },
    select: {
      id: true,
      status: true,
      toShopId: true,
      fromShopId: true,
      lines: {
        select: { id: true, prizeItemId: true, qty: true, batchPlan: true },
      },
    },
  });
  if (!transfer) throw notFound("That transfer no longer exists.");

  if (transfer.status !== "IN_TRANSIT") {
    throw new AppError(
      "CONFLICT",
      transfer.status === "RECEIVED"
        ? "This transfer has already been received."
        : "This transfer was cancelled and cannot be received.",
    );
  }

  for (const line of transfer.lines) {
    const plan = batchPlan.parse(line.batchPlan);

    for (const entry of plan) {
      await tx.prizeBatch.create({
        data: {
          shopId: transfer.toShopId,
          prizeItemId: line.prizeItemId,
          qtyReceived: entry.qty,
          qtyRemaining: entry.qty,
          unitCogs: new Prisma.Decimal(entry.unitCogs),
          // The whole point: FIFO order stays globally honest (§4.10).
          receivedAt: new Date(entry.receivedAt),
          // An uncosted batch stays uncosted after it moves, so it remains in
          // the owner's queue rather than being laundered into a priced batch.
          needsCosting: entry.needsCosting,
          createdById: actor.userId,
          sourceBatchId: entry.sourceBatchId,
        },
      });
    }

    await tx.stockMovement.create({
      data: {
        shopId: transfer.toShopId,
        prizeItemId: line.prizeItemId,
        type: "TRANSFER_IN",
        qtyDelta: line.qty,
        refType: "PrizeTransfer",
        refId: transfer.id,
        userId: actor.userId,
        businessDate,
      },
    });
  }

  await tx.prizeTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "RECEIVED",
      receivedById: actor.userId,
      receivedAt: new Date(),
    },
  });

  await writeAudit(
    actor,
    {
      shopId: transfer.toShopId,
      entity: "PrizeTransfer",
      entityId: transfer.id,
      action: "TRANSFER_RECEIVE",
      after: { direct: opts.direct },
    },
    tx,
  );

  return getTransfer(tx, transfer.id);
}

/** Destination confirms arrival (§4.10 step 2). */
export async function receiveTransfer(
  tx: Prisma.TransactionClient,
  actor: Actor,
  transferId: string,
  businessDate: Date,
) {
  const transfer = await tx.prizeTransfer.findUnique({
    where: { id: transferId },
    select: { id: true, toShopId: true },
  });
  if (!transfer) throw notFound("That transfer no longer exists.");

  // Only the RECEIVING shop confirms arrival.
  assertShopAccess(actor, transfer.toShopId);

  return applyReceive(tx, actor, transferId, businessDate, { direct: false });
}

/**
 * Cancel while IN_TRANSIT: put the units back into the exact source batches.
 *
 * A reason is mandatory (D-38). `restoreConsumption` refuses a second restore
 * (D-27), so a double-tapped cancel cannot invent stock — that guard is the
 * reason there is no separate check here.
 */
export async function cancelTransfer(
  tx: Prisma.TransactionClient,
  actor: Actor,
  transferId: string,
  reason: string,
  businessDate: Date,
) {
  const transfer = await tx.prizeTransfer.findUnique({
    where: { id: transferId },
    select: {
      id: true,
      status: true,
      fromShopId: true,
      lines: { select: { prizeItemId: true, batchPlan: true } },
    },
  });
  if (!transfer) throw notFound("That transfer no longer exists.");

  // Only the SOURCE shop cancels — it is the one getting the stock back.
  assertShopAccess(actor, transfer.fromShopId);

  if (transfer.status !== "IN_TRANSIT") {
    throw new AppError(
      "CONFLICT",
      transfer.status === "RECEIVED"
        ? "This transfer has already been received; transfer it back instead."
        : "This transfer was already cancelled.",
    );
  }

  for (const line of transfer.lines) {
    const plan = batchPlan.parse(line.batchPlan);
    // One movement per line, so one restore per line. Distinct movement ids in
    // a Set guards a malformed plan rather than trusting it to be uniform.
    const movementIds = [...new Set(plan.map((entry) => entry.movementId))];

    for (const movementId of movementIds) {
      await restoreConsumption(tx, {
        movementId,
        shopId: transfer.fromShopId,
        prizeItemId: line.prizeItemId,
        businessDate,
        userId: actor.userId,
        reason,
      });
    }
  }

  await tx.prizeTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "CANCELLED",
      cancelledById: actor.userId,
      cancelledAt: new Date(),
      note: reason,
    },
  });

  await writeAudit(
    actor,
    {
      shopId: transfer.fromShopId,
      entity: "PrizeTransfer",
      entityId: transfer.id,
      action: "TRANSFER_CANCEL",
      before: { status: "IN_TRANSIT" },
      after: { status: "CANCELLED", reason },
    },
    tx,
  );

  return getTransfer(tx, transfer.id);
}

/**
 * One transfer with its lines.
 *
 * Carries NO cost figure. `batchPlan` holds `unitCogs` per source batch, so it
 * is deliberately not selected here — §7.5 forbids a cost value reaching a
 * plain manager, and a transfer list is a manager screen.
 */
export async function getTransfer(
  tx: Prisma.TransactionClient,
  transferId: string,
) {
  const transfer = await tx.prizeTransfer.findUnique({
    where: { id: transferId },
    select: {
      id: true,
      status: true,
      note: true,
      businessDate: true,
      dispatchedAt: true,
      receivedAt: true,
      cancelledAt: true,
      fromShop: { select: { id: true, name: true, code: true } },
      toShop: { select: { id: true, name: true, code: true } },
      lines: {
        select: {
          id: true,
          qty: true,
          prizeItem: { select: { id: true, name: true, sku: true } },
        },
      },
    },
  });
  if (!transfer) throw notFound("That transfer no longer exists.");

  return {
    id: transfer.id,
    status: transfer.status,
    note: transfer.note,
    businessDate: transfer.businessDate.toISOString().slice(0, 10),
    dispatchedAt: transfer.dispatchedAt.toISOString(),
    receivedAt: transfer.receivedAt?.toISOString() ?? null,
    cancelledAt: transfer.cancelledAt?.toISOString() ?? null,
    fromShop: transfer.fromShop,
    toShop: transfer.toShop,
    lines: transfer.lines.map((l) => ({
      id: l.id,
      qty: l.qty,
      prizeItem: l.prizeItem,
    })),
  };
}

/**
 * Inbox of transfers (§7.4). Scoped in SQL, never in JavaScript (§5.6).
 *
 * A manager sees only transfers touching a shop they are assigned to; the
 * caller's `shopId` narrows further but can never widen past that.
 */
export async function listTransfers(
  actor: Actor,
  input: z.infer<typeof listTransfersSchema>,
) {
  if (input.shopId) assertShopAccess(actor, input.shopId);

  const shopFilter = input.shopId
    ? [{ fromShopId: input.shopId }, { toShopId: input.shopId }]
    : actor.isOwner
      ? undefined
      : [
          { fromShopId: { in: assignedShopIds(actor) } },
          { toShopId: { in: assignedShopIds(actor) } },
        ];

  const transfers = await prisma.prizeTransfer.findMany({
    where: {
      ...(shopFilter ? { OR: shopFilter } : {}),
      ...(input.status ? { status: input.status } : {}),
    },
    orderBy: { dispatchedAt: "desc" },
    take: 50,
    select: {
      id: true,
      status: true,
      businessDate: true,
      dispatchedAt: true,
      receivedAt: true,
      cancelledAt: true,
      note: true,
      fromShop: { select: { id: true, name: true, code: true } },
      toShop: { select: { id: true, name: true, code: true } },
      lines: {
        select: {
          id: true,
          qty: true,
          prizeItem: { select: { id: true, name: true, sku: true } },
        },
      },
    },
  });

  return transfers.map((t) => ({
    id: t.id,
    status: t.status,
    note: t.note,
    businessDate: t.businessDate.toISOString().slice(0, 10),
    dispatchedAt: t.dispatchedAt.toISOString(),
    receivedAt: t.receivedAt?.toISOString() ?? null,
    cancelledAt: t.cancelledAt?.toISOString() ?? null,
    fromShop: t.fromShop,
    toShop: t.toShop,
    lines: t.lines.map((l) => ({
      id: l.id,
      qty: l.qty,
      prizeItem: l.prizeItem,
    })),
  }));
}

/**
 * Units currently in transit INTO a shop, for the §8.7 "in-transit" column.
 *
 * Deliberately counts inbound only. Outbound units have already left the
 * source's on-hand figure, so adding them anywhere would double-count.
 */
export async function inTransitTo(
  shopId: string,
  prizeItemId?: string,
): Promise<Map<string, number>> {
  const lines = await prisma.prizeTransferLine.findMany({
    where: {
      transfer: { toShopId: shopId, status: "IN_TRANSIT" },
      ...(prizeItemId ? { prizeItemId } : {}),
    },
    select: { prizeItemId: true, qty: true },
  });

  const totals = new Map<string, number>();
  for (const line of lines) {
    totals.set(
      line.prizeItemId,
      (totals.get(line.prizeItemId) ?? 0) + line.qty,
    );
  }
  return totals;
}

// ─────────────────────── TRANSFER PREVIEW (D-156) ───────────────────────

export const previewTransferSchema = z.object({
  fromShopId: z.string().min(1),
  lines: z
    .array(
      z.object({
        prizeItemId: z.string().min(1),
        qty: z.number().int().positive().max(MAX_QTY),
      }),
    )
    .min(1)
    .max(100),
});

export type PreviewTransferInput = z.infer<typeof previewTransferSchema>;

export interface TransferPreviewLot {
  batchId: string;
  batchCode: string | null;
  qty: number;
  receivedAt: string;
  supplier: string | null;
  /** OWNER / Purchasing-at-this-shop only. Absent otherwise. */
  unitCogs?: string;
  /** qty × unitCogs. Absent when cost is not visible. */
  lineValue?: string;
  /** The lot was received without a price, so it draws at zero (§7.5). */
  needsCosting?: boolean;
}

export interface TransferPreviewLine {
  prizeItemId: string;
  prizeName: string;
  qty: number;
  onHand: number;
  /** True when the branch cannot cover the request — dispatch would 409. */
  short: boolean;
  lots: TransferPreviewLot[];
}

/**
 * A DRY RUN of what dispatch would consume (D-156). Reads only — never writes,
 * never decrements, takes no idempotency key.
 *
 * This exists so the sender can SEE which lots are about to leave before
 * committing, which is the whole point of surfacing batches in the inventory
 * screen. It deliberately does NOT let them choose: FIFO order is the
 * invariant, and a picker would let staff cherry-pick cheap lots and quietly
 * invert the cost basis.
 *
 * **The selection here must mirror `consumeFifo` exactly** — same filter
 * (`qtyRemaining > 0`, not void), same `receivedAt ASC, id ASC` order, same
 * greedy fill. A preview that disagrees with the engine is worse than no
 * preview, so `previews match what consumeFifo actually consumes` pins the two
 * together in the test suite.
 *
 * A preview is a forecast, not a reservation: stock can move between the
 * preview and the dispatch, and the dispatch re-runs FIFO for real under a
 * transaction. `short` reports what we can see now so the UI can warn early;
 * the authoritative refusal is still `InsufficientStockError` at dispatch.
 */
export async function previewTransferPlan(
  actor: Actor,
  input: PreviewTransferInput,
): Promise<TransferPreviewLine[]> {
  assertShopAccess(actor, input.fromShopId);

  const showCost = canSeeCostForShop(actor, input.fromShopId);

  const items = await prisma.prizeItem.findMany({
    where: { id: { in: input.lines.map((l) => l.prizeItemId) } },
    select: { id: true, name: true },
  });
  const nameById = new Map(items.map((i) => [i.id, i.name]));

  const out: TransferPreviewLine[] = [];

  for (const line of input.lines) {
    const batches = await prisma.prizeBatch.findMany({
      where: {
        shopId: input.fromShopId,
        prizeItemId: line.prizeItemId,
        isVoid: false,
        qtyRemaining: { gt: 0 },
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        batchCode: true,
        qtyRemaining: true,
        unitCogs: true,
        supplier: true,
        receivedAt: true,
        needsCosting: true,
      },
    });

    const onHandNow = batches.reduce((sum, b) => sum + b.qtyRemaining, 0);

    let outstanding = line.qty;
    const lots: TransferPreviewLot[] = [];
    for (const b of batches) {
      if (outstanding === 0) break;
      const take = Math.min(b.qtyRemaining, outstanding);
      outstanding -= take;
      lots.push({
        batchId: b.id,
        batchCode: b.batchCode,
        qty: take,
        receivedAt: b.receivedAt.toISOString(),
        supplier: b.supplier,
        // Cost is added only behind the gate. The restricted shape carries no
        // money key at all rather than a nulled-out one.
        ...(showCost
          ? {
              unitCogs: b.unitCogs.toString(),
              lineValue: b.unitCogs.times(take).toString(),
              needsCosting: b.needsCosting,
            }
          : {}),
      });
    }

    out.push({
      prizeItemId: line.prizeItemId,
      prizeName: nameById.get(line.prizeItemId) ?? "Unknown item",
      qty: line.qty,
      onHand: onHandNow,
      short: outstanding > 0,
      lots,
    });
  }

  return out;
}
