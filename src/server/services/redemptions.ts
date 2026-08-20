/**
 * Prize redemption (PRD §4.9, §7.4).
 *
 * The checkout is the most dangerous transaction in the product: it moves
 * tickets, stock and cost basis at once, and staff will double-tap it on shop
 * wifi. §4.9 specifies the order, and it is followed literally:
 *
 *   1. Re-read the customer and their ticket balance.
 *   2. Compute total ticket cost from the SERVER's ticketCost values.
 *   3. Reject if balance < total, or any line exceeds on-hand stock.
 *   4. Insert Redemption + RedemptionLine rows.
 *   5. Consume batches FIFO, insert StockConsumption, decrement qtyRemaining.
 *   6. Insert a TicketLedger REDEEM row and update the cached balance.
 *   7. Insert StockMovement rows of type REDEEM.
 *
 * Steps 5 and 7 are one call to `consumeFifo`, which writes the movement and
 * the consumption rows together — splitting them would let a movement exist
 * without its cost detail.
 *
 * NOTHING here recomputes FIFO or a cost average. Every cost figure comes from
 * `inventory.ts` and is the sum of what those exact units actually cost.
 *
 * The whole function takes a `tx` it did not open (D-10): the caller wraps it in
 * `runIdempotent`, so the redemption and its idempotency key commit together.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import type { Actor } from "@/server/auth/context";
import { assignedShopIds, canSeeCostForShop } from "@/server/auth/context";
import { assertShopAccess } from "@/server/auth/guards";
import { AppError, forbidden, notFound } from "@/server/errors";
import { consumeFifo, restoreConsumption } from "@/server/services/inventory";
import { applyRedemptionTickets } from "@/server/services/tickets";

/** §4.9 allows a void within 24 hours; after that it is a manual adjustment. */
const VOID_WINDOW_MS = 24 * 60 * 60 * 1000;

export const redemptionSchema = z.object({
  customerId: z.string().min(1),
  lines: z
    .array(
      z.object({
        prizeItemId: z.string().min(1),
        qty: z.number().int().positive().max(10_000),
      })
    )
    .min(1, "Add at least one prize.")
    .max(50),
});

export const voidRedemptionSchema = z.object({
  reason: z.string().trim().min(3, "Say why this redemption is being voided.").max(500),
});

export type RedemptionInput = z.infer<typeof redemptionSchema>;
export type VoidRedemptionInput = z.infer<typeof voidRedemptionSchema>;

type WorkingActor = Actor & { workSession: NonNullable<Actor["workSession"]> };

export interface RedemptionLineDTO {
  prizeItemId: string;
  prizeName: string;
  qty: number;
  ticketCostEach: number;
  ticketCostTotal: number;
}

export interface RedemptionDTO {
  id: string;
  shopId: string;
  customerId: string;
  totalTickets: number;
  lines: RedemptionLineDTO[];
  isVoided: boolean;
  businessDate: string;
  occurredAt: string;
}

/**
 * Checkout additionally reports the resulting balance, because the counter
 * screen shows it immediately. History deliberately does NOT — the balance at
 * the time of an old redemption is a ledger question (`TicketLedger`), and
 * reporting a current balance next to a historical row would read as one.
 */
export interface RedemptionReceiptDTO extends RedemptionDTO {
  ticketBalanceAfter: number;
}

/** Cost view, gated by `canSeeCostForShop` exactly as §7.5 requires. */
export interface RedemptionCostDTO extends RedemptionDTO {
  totalCogs: string;
}

export interface RedemptionReceiptCostDTO extends RedemptionReceiptDTO {
  totalCogs: string;
}

/**
 * Redeem prizes for tickets.
 *
 * Duplicate prize lines are merged before anything is written: two lines of the
 * same item would each check stock independently and could together exceed
 * on-hand, since `consumeFifo` only sees one call at a time.
 */
export async function createRedemption(
  actor: WorkingActor,
  input: RedemptionInput,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
): Promise<RedemptionReceiptDTO | RedemptionReceiptCostDTO> {
  const shopId = actor.workSession.shopId;

  const merged = new Map<string, number>();
  for (const line of input.lines) {
    merged.set(line.prizeItemId, (merged.get(line.prizeItemId) ?? 0) + line.qty);
  }

  // Step 1 — the customer must exist, be active, and not be a merge loser.
  const customer = await tx.customer.findUnique({
    where: { id: input.customerId },
    select: { id: true, isActive: true, mergedIntoId: true, ticketBalance: true },
  });
  if (!customer || !customer.isActive || customer.mergedIntoId) {
    throw notFound("That customer no longer exists.");
  }

  // Step 2 — prices come from the database, never from the client. A client
  // that sends its own ticketCost cannot make a prize cheaper than it is.
  const prizeIds = [...merged.keys()];
  const items = await tx.prizeItem.findMany({
    where: { id: { in: prizeIds } },
    select: { id: true, name: true, ticketCost: true, isActive: true },
  });
  if (items.length !== prizeIds.length) {
    throw notFound("One of those prizes no longer exists.");
  }

  const configs = await tx.shopPrizeConfig.findMany({
    where: { shopId, prizeItemId: { in: prizeIds } },
    select: { prizeItemId: true, isActive: true },
  });
  const configByPrize = new Map(configs.map((c) => [c.prizeItemId, c]));

  let totalTickets = 0;
  const plan: Array<{ item: (typeof items)[number]; qty: number; lineTotal: number }> = [];

  for (const item of items) {
    const qty = merged.get(item.id)!;
    if (!item.isActive) {
      throw new AppError("VALIDATION_FAILED", `"${item.name}" is no longer available.`);
    }
    const config = configByPrize.get(item.id);
    if (!config || !config.isActive) {
      // §4.9: staff see only prizes configured at THEIR shop. A direct API call
      // must not be able to redeem an item this branch does not carry.
      throw new AppError(
        "VALIDATION_FAILED",
        `"${item.name}" is not stocked at this shop.`
      );
    }
    const lineTotal = item.ticketCost * qty;
    totalTickets += lineTotal;
    plan.push({ item, qty, lineTotal });
  }

  // Step 3 (tickets) — the authoritative check is the conditional update inside
  // applyRedemptionTickets below, which is what makes two concurrent
  // redemptions safe. This early check exists to fail before any stock moves.
  if (customer.ticketBalance < totalTickets) {
    throw new AppError(
      "INSUFFICIENT_TICKETS",
      `Customer has ${customer.ticketBalance} tickets, but this redemption needs ${totalTickets}.`,
      { balance: customer.ticketBalance, requested: totalTickets }
    );
  }

  // Step 4 — the redemption header. Cost is filled in after FIFO reports it.
  const redemption = await tx.redemption.create({
    data: {
      shopId,
      customerId: customer.id,
      userId: actor.userId,
      totalTickets,
      totalCogs: new Prisma.Decimal(0),
      businessDate: actor.businessDate,
    },
  });

  // Steps 5 and 7 — consume FIFO per line. `consumeFifo` throws
  // INSUFFICIENT_STOCK if a line cannot be filled, rolling back the whole
  // transaction, so a partly-filled cart can never be committed.
  let totalCogs = new Prisma.Decimal(0);
  for (const entry of plan) {
    const consumed = await consumeFifo(tx, {
      shopId,
      prizeItemId: entry.item.id,
      qty: entry.qty,
      type: "REDEEM",
      businessDate: actor.businessDate,
      userId: actor.userId,
      refType: "Redemption",
      refId: redemption.id,
    });

    totalCogs = totalCogs.plus(consumed.totalCogs);

    await tx.redemptionLine.create({
      data: {
        redemptionId: redemption.id,
        prizeItemId: entry.item.id,
        qty: entry.qty,
        ticketCostEach: entry.item.ticketCost,
        ticketCostTotal: entry.lineTotal,
        cogsTotal: consumed.totalCogs,
        movementId: consumed.movement.id,
      },
    });
  }

  await tx.redemption.update({
    where: { id: redemption.id },
    data: { totalCogs },
  });

  // Step 6 — spend the tickets. The conditional update inside this call is the
  // real guard: if a concurrent redemption drained the balance since step 3,
  // this throws and the whole transaction unwinds, including the stock.
  const ticketResult = await applyRedemptionTickets(
    actor,
    customer.id,
    -totalTickets,
    "REDEEM",
    undefined,
    tx
  );

  const dto: RedemptionReceiptDTO = {
    id: redemption.id,
    shopId,
    customerId: customer.id,
    totalTickets,
    lines: plan.map((p) => ({
      prizeItemId: p.item.id,
      prizeName: p.item.name,
      qty: p.qty,
      ticketCostEach: p.item.ticketCost,
      ticketCostTotal: p.lineTotal,
    })),
    isVoided: false,
    businessDate: redemption.businessDate.toISOString().slice(0, 10),
    occurredAt: redemption.occurredAt.toISOString(),
    ticketBalanceAfter: ticketResult.entry.balanceAfter,
  };

  await writeAudit(
    actor,
    {
      entity: "Redemption",
      entityId: redemption.id,
      action: "REDEMPTION_CREATE",
      shopId,
      after: { totalTickets, lines: dto.lines.length },
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  // Money as a string, never a JSON number (D-13, §4.1).
  return canSeeCostForShop(actor, shopId)
    ? { ...dto, totalCogs: totalCogs.toString() }
    : dto;
}

/**
 * Void a redemption within 24 hours (§4.9, OWNER only).
 *
 * Restores the tickets and returns stock to THE EXACT BATCHES it came from, via
 * `restoreConsumption`. That function refuses a second restore (D-27), so a
 * double-tap on void cannot invent stock.
 */
export async function voidRedemption(
  actor: Actor,
  redemptionId: string,
  input: VoidRedemptionInput,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
) {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can void a redemption.");
  }

  const redemption = await tx.redemption.findUnique({
    where: { id: redemptionId },
    include: { lines: true },
  });
  if (!redemption) throw notFound("That redemption no longer exists.");
  if (redemption.isVoided) {
    throw new AppError("CONFLICT", "That redemption has already been voided.");
  }

  const age = Date.now() - redemption.occurredAt.getTime();
  if (age > VOID_WINDOW_MS) {
    throw new AppError(
      "CONFLICT",
      "A redemption can only be voided within 24 hours. Use a stock adjustment and a ticket adjustment instead.",
      { occurredAt: redemption.occurredAt.toISOString() }
    );
  }

  for (const line of redemption.lines) {
    if (!line.movementId) continue;
    await restoreConsumption(tx, {
      movementId: line.movementId,
      shopId: redemption.shopId,
      prizeItemId: line.prizeItemId,
      businessDate: actor.businessDate,
      userId: actor.userId,
      reason: input.reason,
    });
  }

  // The void restores tickets to the customer at the shop doing the void, which
  // is why this needs a work session even though the redemption carries its own
  // shop — the ledger row records where the correction was made.
  const workingActor = actor.workSession
    ? (actor as WorkingActor)
    : null;
  if (!workingActor) {
    throw new AppError(
      "NO_WORK_SESSION",
      "Choose which shop you are working at today before voiding a redemption."
    );
  }

  const ticketResult = await applyRedemptionTickets(
    workingActor,
    redemption.customerId,
    redemption.totalTickets,
    "VOID_RESTORE",
    input.reason,
    tx
  );

  await tx.redemption.update({
    where: { id: redemptionId },
    data: {
      isVoided: true,
      voidedAt: new Date(),
      voidedById: actor.userId,
      voidReason: input.reason,
    },
  });

  await writeAudit(
    actor,
    {
      entity: "Redemption",
      entityId: redemptionId,
      action: "REDEMPTION_VOID",
      shopId: redemption.shopId,
      before: { isVoided: false, totalTickets: redemption.totalTickets },
      after: { isVoided: true },
      reason: input.reason,
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  return {
    id: redemptionId,
    isVoided: true,
    ticketBalanceAfter: ticketResult.entry.balanceAfter,
  };
}

export const listRedemptionsSchema = z.object({
  shopId: z.string().min(1).optional(),
  customerId: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export type ListRedemptionsInput = z.infer<typeof listRedemptionsSchema>;

/** Redemption history. Costs appear only for a caller who passes the gate. */
export async function listRedemptions(actor: Actor, input: ListRedemptionsInput) {
  if (input.shopId) assertShopAccess(actor, input.shopId);

  // Scope is applied as a SQL filter the caller's parameters cannot widen —
  // the Phase 2 pattern. A manager without shopId sees their own shops, never
  // every shop.
  const shopFilter =
    input.shopId !== undefined
      ? { shopId: input.shopId }
      : actor.isOwner
        ? {}
        : { shopId: { in: assignedShopIds(actor) } };

  const rows = await prisma.redemption.findMany({
    where: {
      ...shopFilter,
      ...(input.customerId ? { customerId: input.customerId } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: input.limit ?? 50,
    include: {
      lines: { include: { prizeItem: { select: { id: true, name: true } } } },
    },
  });

  return rows.map((r) => {
    const base: RedemptionDTO = {
      id: r.id,
      shopId: r.shopId,
      customerId: r.customerId,
      totalTickets: r.totalTickets,
      lines: r.lines.map((l) => ({
        prizeItemId: l.prizeItemId,
        prizeName: l.prizeItem.name,
        qty: l.qty,
        ticketCostEach: l.ticketCostEach,
        ticketCostTotal: l.ticketCostTotal,
      })),
      isVoided: r.isVoided,
      businessDate: r.businessDate.toISOString().slice(0, 10),
      occurredAt: r.occurredAt.toISOString(),
    };

    return canSeeCostForShop(actor, r.shopId)
      ? { ...base, totalCogs: r.totalCogs.toString() }
      : base;
  });
}
