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
import type { PrizeItem, PrizeBatch } from "@prisma/client";

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
