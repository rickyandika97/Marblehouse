/**
 * Work session — "which shop am I at today?" (PRD §4.7).
 *
 * One row per (userId, businessDate). It drives the shopId on every record the
 * user creates that day, which is why the client may never assert it: the shop
 * comes from here, and businessDate is computed by the server.
 */
import { z } from "zod";
import { Prisma, type Shop, type WorkSession } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError, forbidden, notFound } from "@/server/errors";
import { writeAudit } from "@/server/audit";
import { assertShopAccess } from "@/server/auth/guards";
import { selectableShops, type Actor } from "@/server/auth/context";

export const setWorkSessionSchema = z.object({
  shopId: z.string().min(1, "Choose a shop."),
});

export const changeWorkSessionSchema = z.object({
  shopId: z.string().min(1, "Choose a shop."),
  reason: z.string().trim().max(500).optional(),
});

export type SetWorkSessionInput = z.infer<typeof setWorkSessionSchema>;
export type ChangeWorkSessionInput = z.infer<typeof changeWorkSessionSchema>;

/** Beyond this many shops the picker switches to a searchable list (§5.6). */
export const SHOP_PICKER_SEARCH_THRESHOLD = 8;

async function loadSelectableShop(actor: Actor, shopId: string): Promise<Shop> {
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });

  if (!shop || !shop.isActive) {
    throw notFound("That shop is not available.");
  }

  // Nobody works at HQ — it is an expense-only pseudo-shop (§4.12).
  if (shop.isHqPseudoShop) {
    throw forbidden("HQ is not a branch you can work at.");
  }

  // The real gate: a manager or staff member may only pick an assigned shop.
  assertShopAccess(actor, shop.id);

  return shop;
}

/**
 * Create today's work session (§7.1 POST /api/work-session).
 *
 * Idempotent by nature of the unique key: if a session already exists for
 * today, this returns it rather than erroring, because two tablets answering
 * the picker at once is an ordinary event, not a fault.
 */
export async function setWorkSession(
  actor: Actor,
  input: SetWorkSessionInput
): Promise<WorkSession & { shop: Shop }> {
  const shop = await loadSelectableShop(actor, input.shopId);

  const existing = await prisma.workSession.findUnique({
    where: {
      userId_businessDate: {
        userId: actor.userId,
        businessDate: actor.businessDate,
      },
    },
    include: { shop: true },
  });

  if (existing) return existing;

  try {
    return await prisma.workSession.create({
      data: {
        userId: actor.userId,
        shopId: shop.id,
        businessDate: actor.businessDate,
      },
      include: { shop: true },
    });
  } catch (e) {
    // Lost a race to create today's session. This is ordinary, not a fault:
    // for a single-shop user the layout and the page both resolve the session
    // on the same request, and a double-tap on the picker does the same thing.
    // The unique key on (userId, businessDate) exists to arbitrate exactly
    // this, so absorb the collision and return the row that won.
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      const winner = await prisma.workSession.findUnique({
        where: {
          userId_businessDate: {
            userId: actor.userId,
            businessDate: actor.businessDate,
          },
        },
        include: { shop: true },
      });
      if (winner) return winner;
    }
    throw e;
  }
}

/**
 * Change today's shop from Settings (§4.7, §7.1 PATCH /api/work-session).
 *
 * Per the PRD this:
 *   - does NOT retroactively move records already created today;
 *   - writes an audit entry with old shop, new shop, timestamp and reason;
 *   - REQUIRES a reason if any records were already created under the old shop.
 */
export async function changeWorkSession(
  actor: Actor,
  input: ChangeWorkSessionInput,
  meta: { ipAddress?: string | null } = {}
): Promise<WorkSession & { shop: Shop }> {
  const shop = await loadSelectableShop(actor, input.shopId);

  const current = await prisma.workSession.findUnique({
    where: {
      userId_businessDate: {
        userId: actor.userId,
        businessDate: actor.businessDate,
      },
    },
    include: { shop: true },
  });

  if (!current) {
    // Nothing to change yet — treat it as the initial selection.
    return setWorkSession(actor, { shopId: input.shopId });
  }

  if (current.shopId === shop.id) return current;

  const priorRecords = await countRecordsToday(actor, current.shopId);
  const reason = input.reason?.trim();

  if (priorRecords > 0 && !reason) {
    throw new AppError(
      "VALIDATION_FAILED",
      `You have already recorded ${priorRecords} item${priorRecords === 1 ? "" : "s"} at ${current.shop.name} today. Give a reason for moving to ${shop.name} — those records stay at ${current.shop.name}.`,
      {
        fields: { reason: "A reason is required." },
        recordsAtOldShop: priorRecords,
      }
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.workSession.update({
      where: { id: current.id },
      data: {
        shopId: shop.id,
        selectedAt: new Date(),
        changedCount: { increment: 1 },
      },
      include: { shop: true },
    });

    await writeAudit(
      actor,
      {
        entity: "WorkSession",
        entityId: current.id,
        action: "CHANGE_SHOP",
        shopId: shop.id,
        before: { shopId: current.shopId, shopName: current.shop.name },
        after: { shopId: shop.id, shopName: shop.name },
        reason: reason ?? null,
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return next;
  });

  return updated;
}

/**
 * How many records has this user already created today at a given shop?
 *
 * Phase 1 has no transactional tables in play yet, so this is zero in
 * practice. It is written now, against the tables that exist, so that the
 * "reason required" rule is real rather than a TODO — later phases extend the
 * list as each table arrives.
 */
async function countRecordsToday(actor: Actor, shopId: string): Promise<number> {
  // Sale attributes the actor as `recordedById`; the ledgers use `userId`.
  const scope = { shopId, businessDate: actor.businessDate };

  const [sales, marbles, tickets] = await Promise.all([
    prisma.sale.count({ where: { ...scope, recordedById: actor.userId } }),
    prisma.marbleLedger.count({ where: { ...scope, userId: actor.userId } }),
    prisma.ticketLedger.count({ where: { ...scope, userId: actor.userId } }),
  ]);

  return sales + marbles + tickets;
}

// ─────────────────────── Day-start resolution (§4.7) ───────────────────────

export interface WorkSessionResolution {
  /** The picker must be shown full-screen and non-dismissible. */
  needsPicker: boolean;
  /** Shops the user may choose from. */
  shops: Shop[];
  /** Pre-selected and listed first (§4.7). */
  defaultShopId: string | null;
  /** Render as a searchable list rather than a tile grid (§5.6). */
  useSearch: boolean;
  session: (WorkSession & { shop: Shop }) | null;
}

/**
 * Decide what the day-start flow should do for this actor, and auto-select
 * when there is exactly one option.
 *
 * "If a user has exactly one assigned shop, auto-select it and skip the
 * prompt." (§4.7) — that auto-selection happens HERE, on the server, so the
 * user never sees a picker they have no choice in.
 */
export async function resolveWorkSession(
  actor: Actor
): Promise<WorkSessionResolution> {
  if (actor.workSession) {
    return {
      needsPicker: false,
      shops: [],
      defaultShopId: actor.workSession.shopId,
      useSearch: false,
      session: actor.workSession,
    };
  }

  const shops = await selectableShops(actor);

  // Exactly one choice → select it silently and land the user on their screen.
  if (shops.length === 1) {
    const only = shops[0]!;
    const session = await setWorkSession(actor, { shopId: only.id });
    return {
      needsPicker: false,
      shops,
      defaultShopId: only.id,
      useSearch: false,
      session,
    };
  }

  // Default shop is pre-selected, and only if it is still a valid choice.
  const defaultShopId =
    actor.defaultShopId && shops.some((s) => s.id === actor.defaultShopId)
      ? actor.defaultShopId
      : null;

  return {
    needsPicker: true,
    shops,
    defaultShopId,
    useSearch: shops.length > SHOP_PICKER_SEARCH_THRESHOLD,
    session: null,
  };
}
