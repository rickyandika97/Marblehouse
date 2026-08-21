/**
 * Prize and stock response shapes (PRD §7.4, §7.5).
 *
 * THE COST GATE LIVES HERE. Two builders per resource, deliberately separate:
 *
 *   toPrizeRestrictedDTO()  name, ticket cost, on-hand, low-stock flag.
 *                           Every role sees this.
 *   toPrizeCostDTO()        the above plus stock valuation — OWNER, or a
 *                           MANAGER with Purchasing AT AN ASSIGNED SHOP.
 *
 * §7.5, and CLAUDE.md: the restricted builder PHYSICALLY DOES NOT READ the cost
 * columns. Never implement this by deleting keys from a full object — a later
 * refactor silently reintroduces the leak and every shape-based test still
 * passes. That is why `toPrizeRestrictedDTO` takes a narrowed input type that
 * does not even carry `unitCogs`: passing a costed row to the restricted
 * builder is a type error, not a code review question.
 *
 * D-28: the pair is named toCostDTO/toRestrictedDTO, not toOwnerDTO — §7.5
 * contradicts itself on this, and "owner" is wrong because a Purchasing manager
 * passes the same gate.
 */
import type { Prisma, PrizeItem, PrizeBatch } from "@prisma/client";

// ─────────────────────────── CATALOG + ON-HAND ───────────────────────────

/** What every role may see about a prize at a shop (§7.4 GET /api/prizes). */
export interface PrizeDTO {
  id: string;
  sku: string;
  name: string;
  category: string | null;
  imagePath: string | null;
  /** Global across every branch (§4.8). */
  ticketCost: number;
  isActive: boolean;
  /** Null when the shop does not stock this item at all. */
  shopConfig: {
    isActive: boolean;
    lowStockThreshold: number;
  } | null;
  onHand: number;
  isLowStock: boolean;
}

/** Additive cost view. Only ever built behind `canSeeCostForShop`. */
export interface PrizeCostDTO extends PrizeDTO {
  /** SUM(qtyRemaining × unitCogs) of live batches at this shop. */
  stockValuation: string;
  /** Batches at this shop still awaiting a cost (§7.5). */
  uncostedBatchCount: number;
}

/**
 * The narrowed input the restricted builder accepts.
 *
 * Note there is no `unitCogs` and no valuation anywhere in this type. A caller
 * holding a costed aggregate cannot pass it here without deliberately stripping
 * the cost first, which is the point.
 */
export interface PrizeRestrictedSource {
  item: Pick<
    PrizeItem,
    "id" | "sku" | "name" | "category" | "imagePath" | "ticketCost" | "isActive"
  >;
  shopConfig: { isActive: boolean; lowStockThreshold: number } | null;
  onHand: number;
}

export function toPrizeRestrictedDTO(source: PrizeRestrictedSource): PrizeDTO {
  const { item, shopConfig, onHand } = source;
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    category: item.category,
    imagePath: item.imagePath,
    ticketCost: item.ticketCost,
    isActive: item.isActive,
    shopConfig,
    onHand,
    // Threshold 0 means "no alert" (§4.8), so it must not fire at zero stock.
    isLowStock:
      shopConfig !== null &&
      shopConfig.lowStockThreshold > 0 &&
      onHand <= shopConfig.lowStockThreshold,
  };
}

export function toPrizeCostDTO(
  source: PrizeRestrictedSource & {
    stockValuation: string;
    uncostedBatchCount: number;
  }
): PrizeCostDTO {
  return {
    ...toPrizeRestrictedDTO(source),
    stockValuation: source.stockValuation,
    uncostedBatchCount: source.uncostedBatchCount,
  };
}

// ─────────────────────────────── BATCHES ───────────────────────────────

/**
 * A batch WITHOUT its cost.
 *
 * §7.4 gates the batch list itself behind Purchasing, but a plain manager still
 * legitimately needs to see stock arriving — this is the shape for that. It
 * carries quantities and provenance and no money at all.
 */
export interface BatchDTO {
  id: string;
  prizeItemId: string;
  shopId: string;
  batchCode: string | null;
  qtyReceived: number;
  qtyRemaining: number;
  supplier: string | null;
  note: string | null;
  isAdjustment: boolean;
  receivedAt: string;
  createdAt: string;
}

export interface BatchCostDTO extends BatchDTO {
  /** Money as a string — Decimal → JSON number is the float bug §4.1 forbids (D-13). */
  unitCogs: string;
  /** qtyRemaining × unitCogs. */
  remainingValue: string;
  needsCosting: boolean;
}

/** Narrowed source: no `unitCogs`, no `needsCosting`. */
export type BatchRestrictedSource = Omit<
  PrizeBatch,
  "unitCogs" | "needsCosting" | "createdById" | "sourceBatchId" | "isVoid"
>;

export function toBatchRestrictedDTO(b: BatchRestrictedSource): BatchDTO {
  return {
    id: b.id,
    prizeItemId: b.prizeItemId,
    shopId: b.shopId,
    batchCode: b.batchCode,
    qtyReceived: b.qtyReceived,
    qtyRemaining: b.qtyRemaining,
    supplier: b.supplier,
    note: b.note,
    isAdjustment: b.isAdjustment,
    receivedAt: b.receivedAt.toISOString(),
    createdAt: b.createdAt.toISOString(),
  };
}

export function toBatchCostDTO(b: PrizeBatch): BatchCostDTO {
  return {
    ...toBatchRestrictedDTO(b),
    unitCogs: b.unitCogs.toString(),
    remainingValue: b.unitCogs.times(b.qtyRemaining).toString(),
    needsCosting: b.needsCosting,
  };
}

// ───────────────────────────── CONSUMPTION ─────────────────────────────

/**
 * Where one batch's units WENT (§4.11) — the drill-down behind a lot in the
 * inventory screen.
 *
 * The same two-builder discipline as the batch pair above, for the same
 * reason: a plain manager legitimately needs to see that eleven units left and
 * who took them, and must never see what they cost. `unitCogsAtConsumption` is
 * the single most sensitive number in the schema — it IS prize expense — so
 * the restricted source type below does not carry it and cannot.
 */

/** What drew the units down, resolved to something a human can read. */
export interface ConsumptionRef {
  /** The movement type, for iconography and grouping. */
  type: string;
  /**
   * A resolved human label — "Ayu Lestari", "Cabang Kemang", "Stock count".
   * Null when the ref no longer resolves (a deleted customer, say); the UI
   * falls back to the type alone rather than printing a raw id.
   */
  label: string | null;
}

/** One draw-down of one batch. No money. Every role that can see the lot. */
export interface ConsumptionDTO {
  id: string;
  batchId: string;
  qty: number;
  /** The business date the movement was booked to, not the wall clock. */
  businessDate: string;
  occurredAt: string;
  ref: ConsumptionRef;
  /** Who did it. Null for a system-generated movement. */
  staffName: string | null;
  /** The movement's free-text reason, where one was required (§4.11). */
  reason: string | null;
}

/** Additive cost view. Only ever built behind `canSeeCostForShop`. */
export interface ConsumptionCostDTO extends ConsumptionDTO {
  /** As recorded AT THE MOMENT OF CONSUMPTION. Never a recomputed average. */
  unitCogs: string;
  /** qty × unitCogs. */
  lineValue: string;
}

/**
 * The narrowed input the restricted builder accepts.
 *
 * There is no `unitCogsAtConsumption` on this type. Passing a costed row here
 * is a type error rather than a code review question — the point of the split.
 */
export interface ConsumptionRestrictedSource {
  id: string;
  batchId: string;
  qty: number;
  businessDate: Date;
  occurredAt: Date;
  ref: ConsumptionRef;
  staffName: string | null;
  reason: string | null;
}

export function toConsumptionRestrictedDTO(
  source: ConsumptionRestrictedSource
): ConsumptionDTO {
  return {
    id: source.id,
    batchId: source.batchId,
    qty: source.qty,
    businessDate: source.businessDate.toISOString(),
    occurredAt: source.occurredAt.toISOString(),
    ref: source.ref,
    staffName: source.staffName,
    reason: source.reason,
  };
}

export function toConsumptionCostDTO(
  source: ConsumptionRestrictedSource & { unitCogs: Prisma.Decimal }
): ConsumptionCostDTO {
  return {
    ...toConsumptionRestrictedDTO(source),
    // Money as a string, never a JSON number (D-13).
    unitCogs: source.unitCogs.toString(),
    lineValue: source.unitCogs.times(source.qty).toString(),
  };
}
