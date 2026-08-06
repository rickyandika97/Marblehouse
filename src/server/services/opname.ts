/**
 * Stock opname — physical count reconciled against the system (PRD §4.11).
 *
 * The anchoring rule is the part that is easy to get wrong and matters most:
 *
 *   "System shows system quantity only AFTER the count is entered, to prevent
 *    anchoring."
 *
 * So `systemQty` is captured by the SERVER at the moment counted quantities are
 * saved, and no read path returns it before then. `startOpname` deliberately
 * returns the item list WITHOUT quantities — if the number reaches the tablet
 * early, a counter who is one short will "find" the missing unit, and the count
 * stops being independent evidence. That is a business control, not UI polish.
 *
 * Variance handling (§4.11):
 *   - Negative (shrinkage) → consume FIFO, categorised OPNAME_LOSS, never
 *     REDEEM. It must land in shrinkage rather than prize expense, because the
 *     owner reads those two lines to mean different things.
 *   - Positive (found stock) → an adjustment batch at the current weighted
 *     average, flagged isAdjustment. This is the ONE caller of
 *     `weightedAverageCost()`, which has existed and been tested since Phase 4
 *     (§15.8, D-31) with nothing wired to it until now.
 *
 * `varianceValue` is OWNER-ONLY (§4.11: "manager sees variance quantity only").
 * It is written to the row, and the read path strips it for anyone who does not
 * pass the cost gate.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/server/audit";
import type { Actor } from "@/server/auth/context";
import { canSeeCostForShop } from "@/server/auth/context";
import { assertShopAccess } from "@/server/auth/guards";
import { AppError, notFound } from "@/server/errors";
import {
  consumeFifo,
  onHand,
  weightedAverageCost,
} from "@/server/services/inventory";

const MAX_QTY = 1_000_000;

export const startOpnameSchema = z.object({
  shopId: z.string().min(1),
  /** Omit to count every prize stocked at this shop. */
  prizeItemIds: z.array(z.string().min(1)).max(500).optional(),
  note: z.string().trim().max(500).optional(),
});

export const saveOpnameLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        prizeItemId: z.string().min(1),
        countedQty: z.number().int().nonnegative().max(MAX_QTY),
      }),
    )
    .min(1)
    .max(500),
});

/**
 * Begin a counting session.
 *
 * Returns the items to count and NOTHING about how many the system thinks are
 * there. See the file header — that omission is the control.
 */
export async function startOpname(
  actor: Actor,
  input: z.infer<typeof startOpnameSchema>,
) {
  assertShopAccess(actor, input.shopId);

  const configs = await prisma.shopPrizeConfig.findMany({
    where: {
      shopId: input.shopId,
      isActive: true,
      ...(input.prizeItemIds?.length
        ? { prizeItemId: { in: input.prizeItemIds } }
        : {}),
    },
    select: {
      prizeItemId: true,
      prizeItem: {
        select: { id: true, name: true, sku: true, isActive: true },
      },
    },
  });

  const items = configs.filter((c) => c.prizeItem.isActive);
  if (items.length === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "This branch has no active prizes configured, so there is nothing to count.",
    );
  }

  const session = await prisma.opnameSession.create({
    data: {
      shopId: input.shopId,
      userId: actor.userId,
      note: input.note ?? null,
      businessDate: actor.businessDate,
    },
    select: { id: true, startedAt: true },
  });

  return {
    id: session.id,
    shopId: input.shopId,
    startedAt: session.startedAt.toISOString(),
    isCommitted: false,
    // Quantities are deliberately absent.
    items: items.map((c) => c.prizeItem),
  };
}

/**
 * Save counted quantities and reveal the variance.
 *
 * `systemQty` is read here, server-side, at save time — not at start. A client
 * that never received the system figure cannot have anchored on it.
 */
export async function saveOpnameLines(
  actor: Actor,
  sessionId: string,
  input: z.infer<typeof saveOpnameLinesSchema>,
) {
  const session = await prisma.opnameSession.findUnique({
    where: { id: sessionId },
    select: { id: true, shopId: true, isCommitted: true },
  });
  if (!session) throw notFound("That stock count no longer exists.");
  assertShopAccess(actor, session.shopId);

  if (session.isCommitted) {
    throw new AppError(
      "CONFLICT",
      "This stock count has already been committed and cannot be changed.",
    );
  }

  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.prizeItemId)) {
      throw new AppError(
        "VALIDATION_FAILED",
        "The same prize was counted twice — enter one count per prize.",
      );
    }
    seen.add(line.prizeItemId);
  }

  const showValue = canSeeCostForShop(actor, session.shopId);

  const lines = await prisma.$transaction(async (tx) => {
    // Replace rather than merge: a re-save is a corrected count, not an
    // addition to the previous one.
    await tx.opnameLine.deleteMany({ where: { sessionId } });

    const created = [];
    for (const line of input.lines) {
      const systemQty = await onHand(tx, session.shopId, line.prizeItemId);
      const variance = line.countedQty - systemQty;

      // Valued at the weighted average, which is the same basis a positive
      // variance is booked at on commit. Written for every line so the owner's
      // variance-value report does not have to recompute it later.
      const unitCost = await weightedAverageCost(
        tx,
        session.shopId,
        line.prizeItemId,
      );
      const varianceValue = unitCost.times(variance).toDecimalPlaces(2);

      created.push(
        await tx.opnameLine.create({
          data: {
            sessionId,
            prizeItemId: line.prizeItemId,
            systemQty,
            countedQty: line.countedQty,
            variance,
            varianceValue,
          },
          select: {
            id: true,
            prizeItemId: true,
            systemQty: true,
            countedQty: true,
            variance: true,
            varianceValue: true,
            prizeItem: { select: { id: true, name: true, sku: true } },
          },
        }),
      );
    }
    return created;
  });

  return {
    sessionId,
    lines: lines.map((l) => toOpnameLineDTO(l, showValue)),
  };
}

/**
 * §4.11: "Owner sees variance value in rupiah; manager sees variance quantity
 * only." The restricted shape does not carry the key at all rather than
 * carrying a nulled one — §7.5's rule, and what `cost-visibility.test.ts` scans
 * serialized output for.
 */
function toOpnameLineDTO(
  line: {
    id: string;
    systemQty: number;
    countedQty: number;
    variance: number;
    varianceValue: Prisma.Decimal | null;
    prizeItem: { id: string; name: string; sku: string | null };
  },
  showValue: boolean,
) {
  const base = {
    id: line.id,
    prizeItem: line.prizeItem,
    systemQty: line.systemQty,
    countedQty: line.countedQty,
    variance: line.variance,
  };
  return showValue
    ? {
        ...base,
        varianceValue: (line.varianceValue ?? new Prisma.Decimal(0)).toString(),
      }
    : base;
}

/**
 * Apply the variances (§4.11).
 *
 * Negative → FIFO consumption categorised OPNAME_LOSS.
 * Positive → an adjustment batch at the weighted average.
 *
 * Both go through `inventory.ts`; nothing here recomputes cost (D-29).
 */
export async function commitOpname(
  actor: Actor,
  sessionId: string,
  businessDate: Date,
) {
  const session = await prisma.opnameSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      shopId: true,
      isCommitted: true,
      lines: {
        select: {
          id: true,
          prizeItemId: true,
          systemQty: true,
          countedQty: true,
          variance: true,
        },
      },
    },
  });
  if (!session) throw notFound("That stock count no longer exists.");
  assertShopAccess(actor, session.shopId);

  if (session.isCommitted) {
    throw new AppError(
      "CONFLICT",
      "This stock count has already been committed.",
    );
  }
  if (session.lines.length === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Enter the counted quantities before committing this stock count.",
    );
  }

  const showValue = canSeeCostForShop(actor, session.shopId);

  return prisma.$transaction(async (tx) => {
    let lossValue = new Prisma.Decimal(0);
    let gainValue = new Prisma.Decimal(0);

    for (const line of session.lines) {
      if (line.variance === 0) continue;

      if (line.variance < 0) {
        // Shrinkage. OPNAME_LOSS, never REDEEM — the owner reads these as
        // different things and §15.9 asserts the category explicitly.
        const result = await consumeFifo(tx, {
          shopId: session.shopId,
          prizeItemId: line.prizeItemId,
          qty: Math.abs(line.variance),
          type: "OPNAME_LOSS",
          businessDate,
          userId: actor.userId,
          refType: "OpnameSession",
          refId: session.id,
          reason: "Stock count shortfall",
        });
        lossValue = lossValue.plus(result.totalCogs);
      } else {
        // Found stock has no batch of its own, so the weighted average is the
        // best available basis (§4.11). Contrast D-31: a MANUAL adjustment is
        // priced at zero, because there it would be an invented number.
        const unitCogs = await weightedAverageCost(
          tx,
          session.shopId,
          line.prizeItemId,
        );

        await tx.prizeBatch.create({
          data: {
            shopId: session.shopId,
            prizeItemId: line.prizeItemId,
            qtyReceived: line.variance,
            qtyRemaining: line.variance,
            unitCogs,
            isAdjustment: true,
            // Found stock was physically already there, so it takes today's
            // date rather than jumping the FIFO queue ahead of real batches.
            receivedAt: new Date(),
            createdById: actor.userId,
            note: "Opname positive variance",
          },
        });

        await tx.stockMovement.create({
          data: {
            shopId: session.shopId,
            prizeItemId: line.prizeItemId,
            type: "OPNAME_GAIN",
            qtyDelta: line.variance,
            refType: "OpnameSession",
            refId: session.id,
            userId: actor.userId,
            reason: "Stock count surplus",
            businessDate,
          },
        });

        gainValue = gainValue.plus(unitCogs.times(line.variance));
      }
    }

    await tx.opnameSession.update({
      where: { id: session.id },
      data: { isCommitted: true, committedAt: new Date() },
    });

    await writeAudit(
      actor,
      {
        entity: "OpnameSession",
        entityId: session.id,
        action: "OPNAME_COMMIT",
        shopId: session.shopId,
        after: {
          lines: session.lines.length,
          shortfalls: session.lines.filter((l) => l.variance < 0).length,
          surpluses: session.lines.filter((l) => l.variance > 0).length,
        },
      },
      tx,
    );

    const summary = {
      id: session.id,
      shopId: session.shopId,
      isCommitted: true,
      linesApplied: session.lines.filter((l) => l.variance !== 0).length,
    };

    // Money as a string, never a JSON number (D-13, §4.1).
    return showValue
      ? {
          ...summary,
          lossValue: lossValue.toString(),
          gainValue: gainValue.toString(),
        }
      : summary;
  });
}

/** One session with its lines, variance value gated per §4.11. */
export async function getOpname(actor: Actor, sessionId: string) {
  const session = await prisma.opnameSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      shopId: true,
      note: true,
      isCommitted: true,
      startedAt: true,
      committedAt: true,
      businessDate: true,
      lines: {
        select: {
          id: true,
          systemQty: true,
          countedQty: true,
          variance: true,
          varianceValue: true,
          prizeItem: { select: { id: true, name: true, sku: true } },
        },
      },
    },
  });
  if (!session) throw notFound("That stock count no longer exists.");
  assertShopAccess(actor, session.shopId);

  const showValue = canSeeCostForShop(actor, session.shopId);

  return {
    id: session.id,
    shopId: session.shopId,
    note: session.note,
    isCommitted: session.isCommitted,
    startedAt: session.startedAt.toISOString(),
    committedAt: session.committedAt?.toISOString() ?? null,
    businessDate: session.businessDate.toISOString().slice(0, 10),
    lines: session.lines.map((l) => toOpnameLineDTO(l, showValue)),
  };
}

/** Recent sessions at a shop. Scoped in SQL, never in JavaScript (§5.6). */
export async function listOpnames(actor: Actor, shopId: string) {
  assertShopAccess(actor, shopId);

  const sessions = await prisma.opnameSession.findMany({
    where: { shopId },
    orderBy: { startedAt: "desc" },
    take: 50,
    select: {
      id: true,
      note: true,
      isCommitted: true,
      startedAt: true,
      committedAt: true,
      businessDate: true,
      _count: { select: { lines: true } },
    },
  });

  return sessions.map((s) => ({
    id: s.id,
    note: s.note,
    isCommitted: s.isCommitted,
    startedAt: s.startedAt.toISOString(),
    committedAt: s.committedAt?.toISOString() ?? null,
    businessDate: s.businessDate.toISOString().slice(0, 10),
    lineCount: s._count.lines,
  }));
}
