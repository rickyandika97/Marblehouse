/**
 * The FIFO inventory engine (PRD §4.8, §4.11, §7.5).
 *
 * THIS IS THE ONLY FILE THAT MAY CONSUME OR RESTORE STOCK. CLAUDE.md forbids
 * inlining FIFO logic anywhere else, and §15 makes this the one module with a
 * mandatory test suite. If you need stock to move, call a function here.
 *
 * Three invariants everything below exists to protect:
 *
 *  1. On-hand = SUM(PrizeBatch.qtyRemaining). There is no qtyOnHand column and
 *     there must never be one.
 *  2. Consumption records `unitCogsAtConsumption` AT THE MOMENT IT HAPPENS.
 *     Prize expense is the sum of those rows — never a recomputed average. A
 *     batch repriced later does not retroactively change what earlier units
 *     cost, with the single exception of `backfillBatchCost` below, which
 *     exists because an uncosted batch was never really priced at zero.
 *  3. Stock can never go negative, checked at commit time inside the
 *     transaction, never against a quantity the client sent.
 *
 * Every function takes a `Prisma.TransactionClient` rather than reaching for
 * `prisma` directly — the D-10 rule. Redemption checkout is one transaction
 * covering the ticket ledger, the batches and the idempotency key; a consume
 * that opened its own transaction would commit stock movement independently of
 * the tickets that paid for it.
 */
import { Prisma, type StockMovementType } from "@prisma/client";
import { AppError } from "@/server/errors";

/** Movement types that DECREASE stock and therefore draw down batches. */
export type ConsumingMovementType = Extract<
  StockMovementType,
  "REDEEM" | "TRANSFER_OUT" | "OPNAME_LOSS" | "DAMAGE" | "MANUAL_ADJUST"
>;

export class InsufficientStockError extends AppError {
  constructor(available: number, requested: number) {
    super(
      "INSUFFICIENT_STOCK",
      `Only ${available} in stock at this shop, but ${requested} requested.`,
      { available, requested }
    );
    this.name = "InsufficientStockError";
  }
}

export interface ConsumptionDetail {
  batchId: string;
  qty: number;
  /** OWNER-ONLY. Never put this in a DTO reachable by a plain manager. */
  unitCogs: Prisma.Decimal;
}

export interface ConsumeResult {
  movement: { id: string; type: StockMovementType; qtyDelta: number };
  consumptions: ConsumptionDetail[];
  /** OWNER-ONLY. Sum of qty × unitCogs at the moment of consumption. */
  totalCogs: Prisma.Decimal;
}

/** Current on-hand for one prize at one shop. Always summed from batches. */
export async function onHand(
  tx: Prisma.TransactionClient,
  shopId: string,
  prizeItemId: string
): Promise<number> {
  const agg = await tx.prizeBatch.aggregate({
    where: { shopId, prizeItemId, isVoid: false },
    _sum: { qtyRemaining: true },
  });
  return agg._sum.qtyRemaining ?? 0;
}

/**
 * Consume `qty` units FIFO and record where every unit came from.
 *
 * Batches are drawn in `receivedAt ASC, id ASC` order. `receivedAt` rather than
 * `createdAt` is deliberate and load-bearing: a batch transferred in from
 * another branch preserves its ORIGINAL receivedAt (§4.10), so an old cheap box
 * that moved branches is still consumed before a newer expensive one. Sorting
 * by createdAt would silently invert the cost basis after every transfer.
 *
 * Concurrency: each batch is decremented with a conditional `updateMany` that
 * re-checks `qtyRemaining >= take` in the WHERE clause. PostgreSQL locks and
 * re-evaluates that row, so two redemptions racing for the last unit cannot
 * both win — the loser sees `count === 0` and retries against fresh state. This
 * is D-20's pattern applied to stock: the database arbitrates, not our code.
 */
export async function consumeFifo(
  tx: Prisma.TransactionClient,
  args: {
    shopId: string;
    prizeItemId: string;
    qty: number;
    type: ConsumingMovementType;
    businessDate: Date;
    userId: string | null;
    refType?: string | null;
    refId?: string | null;
    reason?: string | null;
  }
): Promise<ConsumeResult> {
  if (!Number.isInteger(args.qty) || args.qty <= 0) {
    throw new AppError("VALIDATION_FAILED", "Quantity must be a whole number above zero.");
  }

  const taken: ConsumptionDetail[] = [];
  let outstanding = args.qty;

  // Loop rather than a single pass over a snapshot: a lost race invalidates the
  // quantities we read, so we re-read and continue until the demand is met.
  while (outstanding > 0) {
    const batches = await tx.prizeBatch.findMany({
      where: {
        shopId: args.shopId,
        prizeItemId: args.prizeItemId,
        isVoid: false,
        qtyRemaining: { gt: 0 },
      },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
      select: { id: true, qtyRemaining: true, unitCogs: true },
    });

    const available = batches.reduce((sum, b) => sum + b.qtyRemaining, 0);
    if (available < outstanding) {
      // Nothing has been written yet in a way that survives: the caller's
      // transaction rolls back on this throw, so §15.5's "no partial writes"
      // holds for the batches we already decremented in an earlier iteration.
      throw new InsufficientStockError(
        available + (args.qty - outstanding),
        args.qty
      );
    }

    let progressed = false;
    for (const batch of batches) {
      if (outstanding === 0) break;

      const take = Math.min(batch.qtyRemaining, outstanding);
      const updated = await tx.prizeBatch.updateMany({
        where: { id: batch.id, qtyRemaining: { gte: take } },
        data: { qtyRemaining: { decrement: take } },
      });

      // Lost the race for this batch — someone else took the units between our
      // read and our write. Re-read and try again rather than trusting a count
      // that is now stale.
      if (updated.count !== 1) continue;

      taken.push({ batchId: batch.id, qty: take, unitCogs: batch.unitCogs });
      outstanding -= take;
      progressed = true;
    }

    if (!progressed && outstanding > 0) {
      // Every candidate batch was taken by a concurrent writer. The next
      // iteration re-reads; if stock is genuinely gone the guard above throws.
      continue;
    }
  }

  const movement = await tx.stockMovement.create({
    data: {
      shopId: args.shopId,
      prizeItemId: args.prizeItemId,
      type: args.type,
      qtyDelta: -args.qty,
      refType: args.refType ?? null,
      refId: args.refId ?? null,
      userId: args.userId,
      reason: args.reason ?? null,
      businessDate: args.businessDate,
    },
    select: { id: true, type: true, qtyDelta: true },
  });

  await tx.stockConsumption.createMany({
    data: taken.map((t) => ({
      movementId: movement.id,
      batchId: t.batchId,
      qty: t.qty,
      unitCogsAtConsumption: t.unitCogs,
    })),
  });

  return { movement, consumptions: taken, totalCogs: sumCogs(taken) };
}

/**
 * Put back exactly what a movement took — same batches, same quantities.
 *
 * Used by a redemption void (§4.9) and a cancelled transfer (§4.10). Returning
 * the units to the batches they came from, rather than creating a fresh batch,
 * is what keeps FIFO order and the cost basis honest after a void.
 */
export async function restoreConsumption(
  tx: Prisma.TransactionClient,
  args: {
    movementId: string;
    shopId: string;
    prizeItemId: string;
    businessDate: Date;
    userId: string | null;
    reason?: string | null;
  }
): Promise<ConsumeResult> {
  const consumptions = await tx.stockConsumption.findMany({
    where: { movementId: args.movementId },
    select: { batchId: true, qty: true, unitCogsAtConsumption: true },
  });

  if (consumptions.length === 0) {
    throw new AppError(
      "NOT_FOUND",
      "There is no record of stock being taken for this, so nothing can be put back."
    );
  }

  // A second restore would double-count the stock back in. The marker is a
  // prior VOID_RESTORE movement pointing at the same original movement.
  const alreadyRestored = await tx.stockMovement.findFirst({
    where: { type: "VOID_RESTORE", refType: "StockMovement", refId: args.movementId },
    select: { id: true },
  });
  if (alreadyRestored) {
    throw new AppError(
      "CONFLICT",
      "This stock has already been restored once; it cannot be restored again."
    );
  }

  for (const c of consumptions) {
    await tx.prizeBatch.update({
      where: { id: c.batchId },
      data: { qtyRemaining: { increment: c.qty } },
    });
  }

  const qtyTotal = consumptions.reduce((sum, c) => sum + c.qty, 0);

  const movement = await tx.stockMovement.create({
    data: {
      shopId: args.shopId,
      prizeItemId: args.prizeItemId,
      type: "VOID_RESTORE",
      qtyDelta: qtyTotal,
      refType: "StockMovement",
      refId: args.movementId,
      userId: args.userId,
      reason: args.reason ?? null,
      businessDate: args.businessDate,
    },
    select: { id: true, type: true, qtyDelta: true },
  });

  const detail = consumptions.map((c) => ({
    batchId: c.batchId,
    qty: c.qty,
    unitCogs: c.unitCogsAtConsumption,
  }));

  return { movement, consumptions: detail, totalCogs: sumCogs(detail) };
}

/**
 * Weighted-average unit cost of what is currently on hand.
 *
 * Used ONLY to price a positive opname variance (§4.11) — found stock has no
 * batch of its own, so the adjustment batch is created at this cost. Never use
 * it to value a consumption: that is what `unitCogsAtConsumption` is for.
 *
 * Returns zero when there is nothing on hand, which correctly makes found stock
 * at a brand-new prize free rather than undefined.
 */
export async function weightedAverageCost(
  tx: Prisma.TransactionClient,
  shopId: string,
  prizeItemId: string
): Promise<Prisma.Decimal> {
  const batches = await tx.prizeBatch.findMany({
    where: { shopId, prizeItemId, isVoid: false, qtyRemaining: { gt: 0 } },
    select: { qtyRemaining: true, unitCogs: true },
  });

  let qty = 0;
  let value = new Prisma.Decimal(0);
  for (const b of batches) {
    qty += b.qtyRemaining;
    value = value.plus(b.unitCogs.times(b.qtyRemaining));
  }

  if (qty === 0) return new Prisma.Decimal(0);
  return value.dividedBy(qty).toDecimalPlaces(2);
}

/**
 * Price a batch that was received without a cost, and correct history (§7.5).
 *
 * A manager without the Purchasing permission can receive stock but not price
 * it, so the batch is created at `unitCogs = 0, needsCosting = true` and FIFO
 * consumes it at zero in the meantime. Prize expense is understated until the
 * owner clears the queue — which is why the dashboard warns while any batch is
 * uncosted.
 *
 * This is the ONE place a recorded `unitCogsAtConsumption` may be rewritten,
 * and only for rows recorded at zero against this batch. It is not a repricing
 * tool: a batch that was genuinely priced is never touched here.
 */
export async function backfillBatchCost(
  tx: Prisma.TransactionClient,
  args: { batchId: string; unitCogs: Prisma.Decimal }
): Promise<{ consumptionsUpdated: number; redemptionsUpdated: number }> {
  if (args.unitCogs.lessThan(0)) {
    throw new AppError("VALIDATION_FAILED", "A unit cost cannot be negative.");
  }

  const batch = await tx.prizeBatch.findUnique({
    where: { id: args.batchId },
    select: { id: true, needsCosting: true },
  });
  if (!batch) throw new AppError("NOT_FOUND", "That stock batch no longer exists.");

  await tx.prizeBatch.update({
    where: { id: args.batchId },
    data: { unitCogs: args.unitCogs, needsCosting: false },
  });

  const consumptions = await tx.stockConsumption.findMany({
    where: { batchId: args.batchId, unitCogsAtConsumption: 0 },
    select: { id: true, movementId: true },
  });

  for (const c of consumptions) {
    await tx.stockConsumption.update({
      where: { id: c.id },
      data: { unitCogsAtConsumption: args.unitCogs },
    });
  }

  // Recompute every redemption line whose movement drew on this batch, then the
  // parent totals. Recomputing from the consumption rows rather than adding a
  // delta means a line spanning several backfilled batches still lands right.
  const movementIds = [...new Set(consumptions.map((c) => c.movementId))];
  const lines = await tx.redemptionLine.findMany({
    where: { movementId: { in: movementIds } },
    select: { id: true, movementId: true, redemptionId: true },
  });

  for (const line of lines) {
    const rows = await tx.stockConsumption.findMany({
      where: { movementId: line.movementId! },
      select: { qty: true, unitCogsAtConsumption: true },
    });
    const cogsTotal = rows.reduce(
      (sum, r) => sum.plus(r.unitCogsAtConsumption.times(r.qty)),
      new Prisma.Decimal(0)
    );
    await tx.redemptionLine.update({
      where: { id: line.id },
      data: { cogsTotal },
    });
  }

  const redemptionIds = [...new Set(lines.map((l) => l.redemptionId))];
  for (const redemptionId of redemptionIds) {
    const rows = await tx.redemptionLine.findMany({
      where: { redemptionId },
      select: { cogsTotal: true },
    });
    const totalCogs = rows.reduce(
      (sum, r) => sum.plus(r.cogsTotal),
      new Prisma.Decimal(0)
    );
    await tx.redemption.update({
      where: { id: redemptionId },
      data: { totalCogs },
    });
  }

  return {
    consumptionsUpdated: consumptions.length,
    redemptionsUpdated: redemptionIds.length,
  };
}

function sumCogs(rows: ConsumptionDetail[]): Prisma.Decimal {
  return rows.reduce(
    (sum, r) => sum.plus(r.unitCogs.times(r.qty)),
    new Prisma.Decimal(0)
  );
}
