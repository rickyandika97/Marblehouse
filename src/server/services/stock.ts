/**
 * Stock receiving, the uncosted-batch queue and cost backfill (PRD §7.4, §7.5).
 *
 * This is the service that owns the Purchasing permission. The rule it enforces:
 *
 *   A manager WITHOUT Purchasing can receive stock but cannot price it. Sending
 *   `unitCogs` anyway is a 403 — NOT a silently dropped field. §15 tests that
 *   explicitly, because silently dropping it would let a manager believe they
 *   had recorded a cost that was never stored.
 *
 * Batches received without a cost land at `unitCogs = 0, needsCosting = true`.
 * FIFO consumes them at zero in the meantime, so prize expense is understated
 * until the owner clears the queue — which is why `countUncostedBatches` exists
 * and why the dashboard warns while it is non-zero.
 *
 * All FIFO arithmetic lives in `inventory.ts`. Nothing here recomputes it.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import type { Actor } from "@/server/auth/context";
import { assignedShopIds, canSeeCost, canSeeCostForShop } from "@/server/auth/context";
import { assertShopAccess } from "@/server/auth/guards";
import { AppError, forbidden, notFound } from "@/server/errors";
import { backfillBatchCost, consumeFifo, onHand } from "@/server/services/inventory";
import {
  toBatchCostDTO,
  toBatchRestrictedDTO,
  toConsumptionCostDTO,
  toConsumptionRestrictedDTO,
  type BatchDTO,
  type ConsumptionDTO,
} from "@/server/dto/prize";

const MAX_QTY = 1_000_000;
/** Rp 14 digits with 2 decimals is the column; keep the API well inside it. */
const MAX_UNIT_COGS = 999_999_999.99;

export const receiveBatchSchema = z.object({
  shopId: z.string().min(1),
  prizeItemId: z.string().min(1),
  qtyReceived: z.number().int().positive().max(MAX_QTY),
  supplier: z.string().trim().max(120).optional(),
  batchCode: z.string().trim().max(60).optional(),
  note: z.string().trim().max(500).optional(),
  /** ISO date. Defaults to now. FIFO sorts on this (§4.10). */
  receivedAt: z.string().datetime().optional(),
  /**
   * Present ONLY for a caller who passes the cost gate. The handler does not
   * strip it — the service rejects it, so a non-Purchasing manager gets a 403
   * rather than a batch quietly priced at zero.
   */
  unitCogs: z.number().nonnegative().max(MAX_UNIT_COGS).optional(),
});

export const setBatchCostSchema = z.object({
  unitCogs: z.number().nonnegative().max(MAX_UNIT_COGS),
});

export const listBatchesSchema = z.object({
  shopId: z.string().min(1),
  prizeItemId: z.string().min(1).optional(),
  includeEmpty: z.boolean().optional(),
});

export const adjustStockSchema = z.object({
  shopId: z.string().min(1),
  prizeItemId: z.string().min(1),
  delta: z
    .number()
    .int()
    .min(-MAX_QTY)
    .max(MAX_QTY)
    .refine((v) => v !== 0, "An adjustment cannot be zero."),
  reason: z.string().trim().min(3, "Say why stock is being adjusted.").max(500),
});

export type ReceiveBatchInput = z.infer<typeof receiveBatchSchema>;
export type SetBatchCostInput = z.infer<typeof setBatchCostSchema>;
export type ListBatchesInput = z.infer<typeof listBatchesSchema>;
export type AdjustStockInput = z.infer<typeof adjustStockSchema>;

/**
 * Receive a delivery into a shop (§7.4 POST /api/stock/batches).
 *
 * Idempotent via the caller's transaction (D-10): a double-tap on a slow
 * connection must not create two deliveries.
 */
export async function receiveBatch(
  actor: Actor,
  input: ReceiveBatchInput,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
): Promise<BatchDTO> {
  assertShopAccess(actor, input.shopId);

  const priced = canSeeCostForShop(actor, input.shopId);

  if (input.unitCogs !== undefined && !priced) {
    throw forbidden(
      "You do not have permission to enter costs. Leave the cost blank and the owner will price this delivery."
    );
  }

  const item = await tx.prizeItem.findUnique({
    where: { id: input.prizeItemId },
    select: { id: true, isActive: true },
  });
  if (!item) throw notFound("That prize no longer exists.");
  if (!item.isActive) {
    throw new AppError(
      "VALIDATION_FAILED",
      "That prize is archived. Reactivate it before receiving stock."
    );
  }

  const shop = await tx.shop.findUnique({
    where: { id: input.shopId },
    select: { id: true, isHqPseudoShop: true },
  });
  if (!shop) throw notFound("That shop no longer exists.");
  if (shop.isHqPseudoShop) {
    throw new AppError("VALIDATION_FAILED", "HQ does not hold prize stock.");
  }

  const needsCosting = input.unitCogs === undefined;
  const receivedAt = input.receivedAt ? new Date(input.receivedAt) : new Date();

  const batch = await tx.prizeBatch.create({
    data: {
      shopId: input.shopId,
      prizeItemId: input.prizeItemId,
      qtyReceived: input.qtyReceived,
      qtyRemaining: input.qtyReceived,
      unitCogs: new Prisma.Decimal(input.unitCogs ?? 0),
      needsCosting,
      supplier: input.supplier?.trim() || null,
      batchCode: input.batchCode?.trim() || null,
      note: input.note?.trim() || null,
      receivedAt,
      createdById: actor.userId,
    },
  });

  await tx.stockMovement.create({
    data: {
      shopId: input.shopId,
      prizeItemId: input.prizeItemId,
      type: "RECEIVE",
      qtyDelta: input.qtyReceived,
      refType: "PrizeBatch",
      refId: batch.id,
      userId: actor.userId,
      businessDate: actor.businessDate,
    },
  });

  await writeAudit(
    actor,
    {
      entity: "PrizeBatch",
      entityId: batch.id,
      action: "STOCK_RECEIVE",
      shopId: input.shopId,
      after: {
        prizeItemId: input.prizeItemId,
        qtyReceived: input.qtyReceived,
        needsCosting,
      },
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  // Even the creator only gets the cost shape if they were allowed to set one.
  return priced ? toBatchCostDTO(batch) : toBatchRestrictedDTO(batch);
}

/** Batch list. §7.4 gates this behind the cost permission. */
export async function listBatches(actor: Actor, input: ListBatchesInput) {
  assertShopAccess(actor, input.shopId);

  if (!canSeeCostForShop(actor, input.shopId)) {
    throw forbidden("You do not have permission to view stock costs.");
  }

  const batches = await prisma.prizeBatch.findMany({
    where: {
      shopId: input.shopId,
      ...(input.prizeItemId ? { prizeItemId: input.prizeItemId } : {}),
      isVoid: false,
      ...(input.includeEmpty ? {} : { qtyRemaining: { gt: 0 } }),
    },
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: 200,
  });

  return batches.map(toBatchCostDTO);
}

/**
 * The "Batches awaiting cost" queue (§7.5).
 *
 * The owner sees every shop; a Purchasing manager sees only their own. A plain
 * manager gets 403 — they cannot price stock, so the queue would be a list of
 * costs they may not see.
 */
export async function listUncostedBatches(actor: Actor, shopId?: string) {
  if (shopId) {
    assertShopAccess(actor, shopId);
    if (!canSeeCostForShop(actor, shopId)) {
      throw forbidden("You do not have permission to view stock costs.");
    }
  } else if (!canSeeCost(actor)) {
    // Un-scoped: the owner gets every shop, a Purchasing manager gets their
    // own (the SQL filter below narrows it), and a plain manager is refused.
    // Requiring OWNER here would have locked a Purchasing manager out of the
    // queue §7.5 explicitly gives them — "Purchasing managers see the queue
    // for their own shops".
    throw forbidden("You do not have permission to view stock costs.");
  }

  const batches = await prisma.prizeBatch.findMany({
    where: {
      needsCosting: true,
      isVoid: false,
      ...(shopId
        ? { shopId }
        : actor.isOwner
          ? {}
          // Un-scoped only reaches here for a Purchasing manager (the
          // canSeeCost check above already refused a plain manager/staff) —
          // narrow to the shops where they actually hold cost rights, not
          // merely their full shop membership, so a queue call with no
          // shopId can never surface a shop's costs they aren't cleared for.
          : {
              shopId: {
                in: [...actor.shopRoles.entries()]
                  .filter(([, sr]) => sr.role === "MANAGER" && sr.canEnterCost)
                  .map(([id]) => id),
              },
            }),
    },
    orderBy: [{ receivedAt: "asc" }],
    include: {
      prizeItem: { select: { id: true, name: true, sku: true } },
      shop: { select: { id: true, name: true } },
    },
    take: 200,
  });

  return batches.map((b) => ({
    ...toBatchCostDTO(b),
    prizeItem: b.prizeItem,
    shop: b.shop,
  }));
}

/** How many batches are still unpriced — drives the dashboard warning (§7.5). */
export async function countUncostedBatches(actor: Actor): Promise<number> {
  return prisma.prizeBatch.count({
    where: {
      needsCosting: true,
      isVoid: false,
      ...(actor.isOwner ? {} : { shopId: { in: assignedShopIds(actor) } }),
    },
  });
}

/**
 * Price an uncosted batch and correct the history it already touched (§7.5).
 *
 * The arithmetic is `inventory.backfillBatchCost`; this function owns the
 * permission check, the audit row, and the transaction the two share.
 */
export async function setBatchCost(
  actor: Actor,
  batchId: string,
  input: SetBatchCostInput,
  meta: { ipAddress?: string | null } = {}
) {
  const batch = await prisma.prizeBatch.findUnique({
    where: { id: batchId },
    select: {
      id: true,
      shopId: true,
      unitCogs: true,
      needsCosting: true,
      isVoid: true,
    },
  });
  if (!batch) throw notFound("That stock batch no longer exists.");

  assertShopAccess(actor, batch.shopId);
  if (!canSeeCostForShop(actor, batch.shopId)) {
    throw forbidden("You do not have permission to set stock costs.");
  }
  if (batch.isVoid) {
    throw new AppError("VALIDATION_FAILED", "That batch has been voided.");
  }

  const unitCogs = new Prisma.Decimal(input.unitCogs);

  return prisma.$transaction(async (tx) => {
    const summary = await backfillBatchCost(tx, { batchId, unitCogs });

    await writeAudit(
      actor,
      {
        entity: "PrizeBatch",
        entityId: batchId,
        action: "STOCK_BATCH_COST_SET",
        shopId: batch.shopId,
        before: { unitCogs: batch.unitCogs.toString(), needsCosting: batch.needsCosting },
        after: {
          unitCogs: unitCogs.toString(),
          needsCosting: false,
          consumptionsUpdated: summary.consumptionsUpdated,
          redemptionsUpdated: summary.redemptionsUpdated,
        },
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    const updated = await tx.prizeBatch.findUniqueOrThrow({ where: { id: batchId } });
    return { batch: toBatchCostDTO(updated), ...summary };
  });
}

/**
 * Manual stock adjustment (§7.4 POST /api/stock/adjust).
 *
 * A negative delta consumes FIFO so the cost basis stays honest; a positive one
 * creates an adjustment batch. Positive adjustments are priced at zero and
 * flagged `needsCosting` rather than guessed at — found stock has no delivery
 * behind it, and inventing a cost would quietly distort prize expense. The
 * weighted-average path is reserved for opname (§4.11), which is Phase 5.
 */
export async function adjustStock(
  actor: Actor,
  input: AdjustStockInput,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
) {
  assertShopAccess(actor, input.shopId);

  if (input.delta < 0) {
    await consumeFifo(tx, {
      shopId: input.shopId,
      prizeItemId: input.prizeItemId,
      qty: -input.delta,
      type: "MANUAL_ADJUST",
      businessDate: actor.businessDate,
      userId: actor.userId,
      reason: input.reason,
    });
  } else {
    const batch = await tx.prizeBatch.create({
      data: {
        shopId: input.shopId,
        prizeItemId: input.prizeItemId,
        qtyReceived: input.delta,
        qtyRemaining: input.delta,
        unitCogs: new Prisma.Decimal(0),
        needsCosting: true,
        isAdjustment: true,
        note: input.reason,
        receivedAt: new Date(),
        createdById: actor.userId,
      },
    });

    await tx.stockMovement.create({
      data: {
        shopId: input.shopId,
        prizeItemId: input.prizeItemId,
        type: "MANUAL_ADJUST",
        qtyDelta: input.delta,
        refType: "PrizeBatch",
        refId: batch.id,
        userId: actor.userId,
        reason: input.reason,
        businessDate: actor.businessDate,
      },
    });
  }

  await writeAudit(
    actor,
    {
      entity: "PrizeItem",
      entityId: input.prizeItemId,
      action: "STOCK_ADJUST",
      shopId: input.shopId,
      after: { delta: input.delta },
      reason: input.reason,
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  return {
    prizeItemId: input.prizeItemId,
    shopId: input.shopId,
    onHand: await onHand(tx, input.shopId, input.prizeItemId),
  };
}

// ─────────────────── INVENTORY DRILL-DOWN READS (D-156) ───────────────────

export const listBatchesForItemSchema = z.object({
  shopId: z.string().min(1),
  prizeItemId: z.string().min(1),
});

export const listBatchConsumptionSchema = z.object({
  batchId: z.string().min(1),
});

export type ListBatchesForItemInput = z.infer<typeof listBatchesForItemSchema>;
export type ListBatchConsumptionInput = z.infer<
  typeof listBatchConsumptionSchema
>;

/** A lot's history is long-tailed; nobody scrolls past this in a drawer. */
const CONSUMPTION_PAGE = 200;

/**
 * Every lot of one prize at one shop, in FIFO order (D-156).
 *
 * Deliberately NOT `listBatches`. That one is the costed endpoint §7.4 gates
 * behind Purchasing, and it stays that way. But a plain manager running a
 * branch legitimately needs to see that four boxes arrived and two are empty —
 * refusing them the quantities as well as the costs is what made the batch
 * list unreachable from the UI for everyone but the owner.
 *
 * So the GATE HERE IS ON SHAPE, NOT ACCESS: a manager who fails
 * `canSeeCostForShop` gets `BatchDTO[]` built by the restricted builder, which
 * cannot read `unitCogs`. `includeEmpty` is always on — a drained lot is the
 * interesting one when you are asking where the stock went.
 */
export async function listBatchesForItem(
  actor: Actor,
  input: ListBatchesForItemInput
): Promise<BatchDTO[]> {
  assertShopAccess(actor, input.shopId);

  const batches = await prisma.prizeBatch.findMany({
    where: {
      shopId: input.shopId,
      prizeItemId: input.prizeItemId,
      isVoid: false,
    },
    // The FIFO order itself (§4.10) — receivedAt, NOT createdAt, so a lot
    // transferred in from another branch sits in its original position.
    orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    take: 200,
  });

  if (!canSeeCostForShop(actor, input.shopId)) {
    return batches.map(toBatchRestrictedDTO);
  }
  return batches.map(toBatchCostDTO);
}

/**
 * Where one lot's units went (D-156) — the consumption drill-down.
 *
 * Access is checked against the BATCH'S OWN SHOP, which has to be read first:
 * the caller supplies only a batch id, so there is no shop to authorise
 * against until we have the row. Passing another branch's batch id is a 403,
 * not an empty list — an empty list would tell a manager the lot exists.
 *
 * Cost is gated on shape exactly as above. A plain manager sees who took what
 * and when; `unitCogsAtConsumption` never reaches them.
 */
export async function listBatchConsumption(
  actor: Actor,
  input: ListBatchConsumptionInput
): Promise<ConsumptionDTO[]> {
  const batch = await prisma.prizeBatch.findUnique({
    where: { id: input.batchId },
    select: { id: true, shopId: true },
  });
  if (!batch) throw notFound("That batch no longer exists.");

  assertShopAccess(actor, batch.shopId);

  const rows = await prisma.stockConsumption.findMany({
    where: { batchId: batch.id },
    orderBy: [{ createdAt: "desc" }],
    take: CONSUMPTION_PAGE,
    select: {
      id: true,
      qty: true,
      unitCogsAtConsumption: true,
      movement: {
        select: {
          type: true,
          refType: true,
          refId: true,
          reason: true,
          businessDate: true,
          occurredAt: true,
          // `StockMovement.userId` is a bare scalar with no relation on it, so
          // the name is resolved in the same batched pass as the refs below
          // rather than by a join that does not exist.
          userId: true,
        },
      },
    },
  });

  const [labels, staff] = await Promise.all([
    resolveConsumptionLabels(rows.map((r) => r.movement)),
    resolveStaffNames(rows.map((r) => r.movement.userId)),
  ]);

  const sources = rows.map((r) => ({
    id: r.id,
    batchId: batch.id,
    qty: r.qty,
    businessDate: r.movement.businessDate,
    occurredAt: r.movement.occurredAt,
    ref: {
      type: r.movement.type,
      label: labels.get(refKey(r.movement.refType, r.movement.refId)) ?? null,
    },
    staffName: r.movement.userId
      ? (staff.get(r.movement.userId) ?? null)
      : null,
    reason: r.movement.reason,
  }));

  if (!canSeeCostForShop(actor, batch.shopId)) {
    return sources.map(toConsumptionRestrictedDTO);
  }
  return sources.map((s, i) =>
    toConsumptionCostDTO({
      ...s,
      // `sources` is built by mapping `rows`, so the index always lands.
      unitCogs: rows[i]!.unitCogsAtConsumption,
    })
  );
}

/** Staff display names for a set of movement `userId`s, in one query. */
async function resolveStaffNames(
  userIds: Array<string | null>
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  });
  return new Map(users.map((u) => [u.id, u.displayName]));
}

function refKey(refType: string | null, refId: string | null): string {
  return `${refType ?? ""}:${refId ?? ""}`;
}

/**
 * Turn `refType`/`refId` pairs into names a human can read.
 *
 * ONE GROUPED QUERY PER REF TYPE, never a lookup per row: a popular prize's
 * lot is drained by hundreds of separate redemptions, and a per-row join would
 * make opening the drawer an N+1 against the busiest table in the schema.
 *
 * A ref that no longer resolves yields no entry, and the DTO's label falls
 * back to null — the UI then shows the movement type alone. That is the right
 * outcome for a deleted customer, and it means this function never throws and
 * never blocks the history from rendering.
 */
async function resolveConsumptionLabels(
  movements: Array<{ refType: string | null; refId: string | null }>
): Promise<Map<string, string>> {
  const byType = new Map<string, Set<string>>();
  for (const m of movements) {
    if (!m.refType || !m.refId) continue;
    let set = byType.get(m.refType);
    if (!set) byType.set(m.refType, (set = new Set()));
    set.add(m.refId);
  }

  const out = new Map<string, string>();
  const ids = (t: string) => [...(byType.get(t) ?? [])];

  const [redemptions, transfers, opnames] = await Promise.all([
    ids("Redemption").length
      ? prisma.redemption.findMany({
          where: { id: { in: ids("Redemption") } },
          select: { id: true, customer: { select: { name: true } } },
        })
      : [],
    ids("PrizeTransfer").length
      ? prisma.prizeTransfer.findMany({
          where: { id: { in: ids("PrizeTransfer") } },
          select: { id: true, toShop: { select: { name: true } } },
        })
      : [],
    ids("OpnameSession").length
      ? prisma.opnameSession.findMany({
          where: { id: { in: ids("OpnameSession") } },
          select: { id: true, businessDate: true },
        })
      : [],
  ]);

  for (const r of redemptions) {
    out.set(refKey("Redemption", r.id), r.customer.name);
  }
  for (const t of transfers) {
    // Named for the DESTINATION: on a batch drill-down you are always looking
    // at the sending shop's stock, so "to Kemang" is the useful half.
    out.set(refKey("PrizeTransfer", t.id), `To ${t.toShop.name}`);
  }
  for (const o of opnames) {
    out.set(
      refKey("OpnameSession", o.id),
      `Stock count ${o.businessDate.toISOString().slice(0, 10)}`
    );
  }

  return out;
}
