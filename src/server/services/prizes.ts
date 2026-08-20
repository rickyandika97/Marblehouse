/**
 * Prize catalog and per-shop stocking policy (PRD §4.8, §7.4).
 *
 * The catalog is GLOBAL: one `PrizeItem` row serves every branch, and
 * `ticketCost` lives on it rather than on `ShopPrizeConfig` — a customer who
 * visits three branches sees one price (§4.8, and a decision CLAUDE.md marks as
 * closed). `ShopPrizeConfig` holds only what is legitimately branch-specific:
 * whether this branch carries the item, and when to warn about low stock.
 *
 * Cost never appears here unless the caller passed `canSeeCostForShop`. The
 * split is enforced by the DTO builders in `src/server/dto/prize.ts`, not by
 * conditional field deletion.
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
  toPrizeCostDTO,
  toPrizeRestrictedDTO,
  type PrizeDTO,
} from "@/server/dto/prize";
import { deletePrizeImage } from "@/server/services/prize-image";

const MAX_TICKET_COST = 1_000_000;

export const createPrizeSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1, "A SKU is required.")
    .max(40)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores."),
  name: z.string().trim().min(1, "A name is required.").max(120),
  category: z.string().trim().max(60).optional(),
  ticketCost: z.number().int().positive().max(MAX_TICKET_COST),
});

export const updatePrizeSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().max(60).nullable().optional(),
    ticketCost: z.number().int().positive().max(MAX_TICKET_COST).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Nothing to update.");

/**
 * Strict on purpose: ticket cost is global (§4.8) and must not be settable per
 * shop. A request smuggling `ticketCost` here is REJECTED rather than having
 * the field quietly stripped, so a client bug surfaces instead of a manager
 * believing they set a branch price that was never stored.
 */
export const shopPrizeConfigSchema = z
  .object({
    lowStockThreshold: z.number().int().min(0).max(1_000_000),
    isActive: z.boolean(),
  })
  .strict();

export const listPrizesSchema = z.object({
  shopId: z.string().min(1),
  /** Include items this branch does not carry, for the "add to shop" picker. */
  includeUnstocked: z.boolean().optional(),
  q: z.string().trim().max(80).optional(),
});

export type CreatePrizeInput = z.infer<typeof createPrizeSchema>;
export type UpdatePrizeInput = z.infer<typeof updatePrizeSchema>;
export type ShopPrizeConfigInput = z.infer<typeof shopPrizeConfigSchema>;
export type ListPrizesInput = z.infer<typeof listPrizesSchema>;

/**
 * Catalog for one shop, with on-hand quantities and low-stock flags.
 *
 * On-hand is summed from batches in SQL via groupBy — never a `qtyOnHand`
 * column (§4.8, CLAUDE.md). One grouped query serves the whole list rather than
 * one aggregate per prize, because this list renders on the redemption screen
 * where §8.6 wants it fast.
 */
export async function listPrizes(
  actor: Actor,
  input: ListPrizesInput
): Promise<PrizeDTO[]> {
  assertShopAccess(actor, input.shopId);

  const items = await prisma.prizeItem.findMany({
    where: {
      ...(input.q
        ? {
            OR: [
              { name: { contains: input.q, mode: "insensitive" } },
              { sku: { contains: input.q, mode: "insensitive" } },
            ],
          }
        : {}),
      ...(input.includeUnstocked
        ? {}
        : { configs: { some: { shopId: input.shopId, isActive: true } } }),
    },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    take: 500,
  });

  if (items.length === 0) return [];
  const prizeIds = items.map((i) => i.id);

  const [configs, stock] = await Promise.all([
    prisma.shopPrizeConfig.findMany({
      where: { shopId: input.shopId, prizeItemId: { in: prizeIds } },
    }),
    prisma.prizeBatch.groupBy({
      by: ["prizeItemId"],
      where: {
        shopId: input.shopId,
        prizeItemId: { in: prizeIds },
        isVoid: false,
      },
      _sum: { qtyRemaining: true },
    }),
  ]);

  const configByPrize = new Map(configs.map((c) => [c.prizeItemId, c]));
  const onHandByPrize = new Map(
    stock.map((s) => [s.prizeItemId, s._sum.qtyRemaining ?? 0])
  );

  const sources = items.map((item) => {
    const config = configByPrize.get(item.id);
    return {
      item,
      shopConfig: config
        ? {
            isActive: config.isActive,
            lowStockThreshold: config.lowStockThreshold,
          }
        : null,
      onHand: onHandByPrize.get(item.id) ?? 0,
    };
  });

  // The gate. A plain manager or any staff member never reaches the cost
  // branch, and the restricted builder cannot read a cost column even if they
  // did — see the narrowed source type in dto/prize.ts.
  if (!canSeeCostForShop(actor, input.shopId)) {
    return sources.map(toPrizeRestrictedDTO);
  }

  const [valuations, uncosted] = await Promise.all([
    prisma.prizeBatch.findMany({
      where: {
        shopId: input.shopId,
        prizeItemId: { in: prizeIds },
        isVoid: false,
        qtyRemaining: { gt: 0 },
      },
      select: { prizeItemId: true, qtyRemaining: true, unitCogs: true },
    }),
    prisma.prizeBatch.groupBy({
      by: ["prizeItemId"],
      where: {
        shopId: input.shopId,
        prizeItemId: { in: prizeIds },
        isVoid: false,
        needsCosting: true,
      },
      _count: { _all: true },
    }),
  ]);

  const valueByPrize = new Map<string, Prisma.Decimal>();
  for (const b of valuations) {
    const current = valueByPrize.get(b.prizeItemId) ?? new Prisma.Decimal(0);
    valueByPrize.set(b.prizeItemId, current.plus(b.unitCogs.times(b.qtyRemaining)));
  }
  const uncostedByPrize = new Map(
    uncosted.map((u) => [u.prizeItemId, u._count._all])
  );

  return sources.map((s) =>
    toPrizeCostDTO({
      ...s,
      stockValuation: (valueByPrize.get(s.item.id) ?? new Prisma.Decimal(0)).toString(),
      uncostedBatchCount: uncostedByPrize.get(s.item.id) ?? 0,
    })
  );
}

/**
 * Create a catalog item.
 *
 * Takes the actor even though the create itself needs no shop scoping: §5.4
 * says no service function queries the database without knowing who is asking,
 * and the audit row records the author.
 */
export async function createPrize(
  actor: Actor,
  input: CreatePrizeInput,
  meta: { ipAddress?: string | null } = {}
) {
  const existing = await prisma.prizeItem.findUnique({
    where: { sku: input.sku },
    select: { id: true },
  });
  if (existing) {
    throw new AppError(
      "CONFLICT",
      `SKU "${input.sku}" is already used by another prize.`
    );
  }

  const item = await prisma.$transaction(async (tx) => {
    const created = await tx.prizeItem.create({
      data: {
        sku: input.sku,
        name: input.name,
        category: input.category?.trim() || null,
        ticketCost: input.ticketCost,
      },
    });

    await writeAudit(
      actor,
      {
        entity: "PrizeItem",
        entityId: created.id,
        action: "PRIZE_CREATE",
        after: { sku: created.sku, name: created.name, ticketCost: created.ticketCost },
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return created;
  });

  return toPrizeRestrictedDTO({ item, shopConfig: null, onHand: 0 });
}

/**
 * Update a catalog item.
 *
 * Changing `ticketCost` changes the price at EVERY branch, including ones the
 * editing manager does not manage (§4.8). The PRD's mitigation is threefold: a
 * warning on the field, an audit row with old and new value, and an owner
 * alert. The first is UI; the other two are here.
 */
export async function updatePrize(
  actor: Actor,
  prizeItemId: string,
  input: UpdatePrizeInput,
  meta: { ipAddress?: string | null } = {}
) {
  const before = await prisma.prizeItem.findUnique({ where: { id: prizeItemId } });
  if (!before) throw notFound("That prize no longer exists.");

  const ticketCostChanged =
    input.ticketCost !== undefined && input.ticketCost !== before.ticketCost;

  const item = await prisma.$transaction(async (tx) => {
    const updated = await tx.prizeItem.update({
      where: { id: prizeItemId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.category !== undefined
          ? { category: input.category?.trim() || null }
          : {}),
        ...(input.ticketCost !== undefined ? { ticketCost: input.ticketCost } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });

    if (ticketCostChanged) {
      await writeAudit(
        actor,
        {
          entity: "PrizeItem",
          entityId: prizeItemId,
          action: "PRIZE_TICKET_COST_CHANGE",
          shopId: actor.workSession?.shopId ?? null,
          before: { ticketCost: before.ticketCost },
          after: { ticketCost: updated.ticketCost },
          reason: null,
          ipAddress: meta.ipAddress ?? null,
        },
        tx
      );

      // §4.8 wants the owner told, because the change reaches branches the
      // editor may not manage. Upsert keyed per prize so repeated edits update
      // one row rather than flooding the dashboard.
      await tx.systemAlert.upsert({
        where: { key: `TICKET_COST_CHANGED:${prizeItemId}` },
        create: {
          key: `TICKET_COST_CHANGED:${prizeItemId}`,
          severity: "WARNING",
          title: `Ticket price changed: ${updated.name}`,
          message:
            `${actor.displayName} changed the price of "${updated.name}" from ` +
            `${before.ticketCost} to ${updated.ticketCost} tickets. ` +
            `This price applies at every branch.`,
          details: {
            prizeItemId,
            from: before.ticketCost,
            to: updated.ticketCost,
            changedByUserId: actor.userId,
          },
        },
        update: {
          isActive: true,
          lastSeenAt: new Date(),
          message:
            `${actor.displayName} changed the price of "${updated.name}" from ` +
            `${before.ticketCost} to ${updated.ticketCost} tickets. ` +
            `This price applies at every branch.`,
          details: {
            prizeItemId,
            from: before.ticketCost,
            to: updated.ticketCost,
            changedByUserId: actor.userId,
          },
        },
      });
    }

    return updated;
  });

  return toPrizeRestrictedDTO({ item, shopConfig: null, onHand: 0 });
}

/**
 * Set whether a branch carries an item, and its low-stock threshold (§7.4).
 *
 * Ticket cost is deliberately NOT settable here — it is global and lives on the
 * catalog item. A request that tries to smuggle it in fails Zod validation
 * rather than being silently ignored.
 */
export async function setShopPrizeConfig(
  actor: Actor,
  shopId: string,
  prizeItemId: string,
  input: ShopPrizeConfigInput
) {
  assertShopAccess(actor, shopId);

  const [shop, item] = await Promise.all([
    prisma.shop.findUnique({ where: { id: shopId }, select: { id: true, isHqPseudoShop: true } }),
    prisma.prizeItem.findUnique({ where: { id: prizeItemId }, select: { id: true } }),
  ]);
  if (!shop) throw notFound("That shop no longer exists.");
  if (!item) throw notFound("That prize no longer exists.");
  if (shop.isHqPseudoShop) {
    // HQ is an expense-only pseudo-shop (§4.12); stocking prizes there would
    // put inventory somewhere no customer can redeem it.
    throw new AppError("VALIDATION_FAILED", "HQ does not hold prize stock.");
  }

  const config = await prisma.shopPrizeConfig.upsert({
    where: { shopId_prizeItemId: { shopId, prizeItemId } },
    create: {
      shopId,
      prizeItemId,
      lowStockThreshold: input.lowStockThreshold,
      isActive: input.isActive,
    },
    update: {
      lowStockThreshold: input.lowStockThreshold,
      isActive: input.isActive,
    },
  });

  return {
    shopId: config.shopId,
    prizeItemId: config.prizeItemId,
    lowStockThreshold: config.lowStockThreshold,
    isActive: config.isActive,
  };
}

/**
 * Attach (or replace) a prize's catalog image (§4.8, §8.6).
 *
 * MANAGER or OWNER, matching every other catalog mutation — the route enforces
 * the role, and this needs no shop scoping because the catalog is global.
 *
 * **The superseded file is deleted.** A prize image is a corrigible attribute,
 * not a record: replacing it three times must not leave three files on disk,
 * or the data directory grows without bound and every backup carries the dead
 * weight. Deletion happens AFTER the database row is updated, so a failed
 * unlink can only ever orphan a file — it can never leave the row pointing at
 * a file that is already gone, which is the failure the redemption grid would
 * actually notice.
 */
export async function setPrizeImage(
  actor: Actor,
  prizeItemId: string,
  relativePath: string,
  meta: { ipAddress?: string | null } = {}
): Promise<PrizeDTO> {
  const before = await prisma.prizeItem.findUnique({
    where: { id: prizeItemId },
    select: { id: true, imagePath: true },
  });
  if (!before) throw notFound("That prize no longer exists.");

  const item = await prisma.$transaction(async (tx) => {
    const updated = await tx.prizeItem.update({
      where: { id: prizeItemId },
      data: { imagePath: relativePath },
    });

    await writeAudit(
      actor,
      {
        entity: "PrizeItem",
        entityId: prizeItemId,
        action: "PRIZE_IMAGE_SET",
        before: { imagePath: before.imagePath },
        after: { imagePath: relativePath },
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return updated;
  });

  if (before.imagePath && before.imagePath !== relativePath) {
    await deletePrizeImage(before.imagePath).catch(() => {
      // An orphaned file is untidy; a failed request here would be worse,
      // because the new image is already live and the caller would retry an
      // upload that has in fact succeeded.
    });
  }

  return toPrizeRestrictedDTO({ item, shopConfig: null, onHand: 0 });
}

/**
 * Remove a prize's image, returning it to the placeholder (§8.6).
 *
 * Idempotent: removing an image from a prize that has none is a success, not a
 * 404. The caller's intent — "this prize should have no image" — is already
 * satisfied, and a double-tap on shop wifi must not produce an error.
 */
export async function clearPrizeImage(
  actor: Actor,
  prizeItemId: string,
  meta: { ipAddress?: string | null } = {}
): Promise<PrizeDTO> {
  const before = await prisma.prizeItem.findUnique({
    where: { id: prizeItemId },
    select: { id: true, imagePath: true },
  });
  if (!before) throw notFound("That prize no longer exists.");

  const item = await prisma.$transaction(async (tx) => {
    const updated = await tx.prizeItem.update({
      where: { id: prizeItemId },
      data: { imagePath: null },
    });

    // Only audit a change that actually happened. Logging a no-op removal
    // would pad the audit trail with rows that record nothing.
    if (before.imagePath) {
      await writeAudit(
        actor,
        {
          entity: "PrizeItem",
          entityId: prizeItemId,
          action: "PRIZE_IMAGE_CLEAR",
          before: { imagePath: before.imagePath },
          after: { imagePath: null },
          ipAddress: meta.ipAddress ?? null,
        },
        tx
      );
    }

    return updated;
  });

  if (before.imagePath) {
    await deletePrizeImage(before.imagePath).catch(() => {});
  }

  return toPrizeRestrictedDTO({ item, shopConfig: null, onHand: 0 });
}

/**
 * The stored path for one prize's image, for the authenticated image route.
 *
 * Any signed-in role may read it — staff need prize images to redeem (§8.6).
 * There is no shop scoping because the catalog is global: an image is not a
 * per-branch secret, and a manager at one branch seeing another's prize photo
 * discloses nothing.
 */
export async function getPrizeImagePath(
  actor: Actor,
  prizeItemId: string
): Promise<string> {
  // `actor` is unused for scoping but required: §5.4 says no service function
  // queries the database without knowing who is asking, and the route's guard
  // is what makes this authenticated-only rather than public.
  void actor;

  const item = await prisma.prizeItem.findUnique({
    where: { id: prizeItemId },
    select: { imagePath: true },
  });
  if (!item) throw notFound("That prize no longer exists.");
  if (!item.imagePath) throw notFound("That prize has no image.");

  return item.imagePath;
}
