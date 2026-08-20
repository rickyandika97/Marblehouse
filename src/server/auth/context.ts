/**
 * Request-scoped actor context (PRD §5.4).
 *
 * "On every request, middleware loads the session, user, role, shop
 * assignments and today's work session into a request-scoped context. Every
 * service function receives this context. NO SERVICE FUNCTION MAY QUERY THE
 * DATABASE WITHOUT KNOWING THE ACTOR."
 *
 * That last sentence is the reason this file exists. If you find yourself
 * wanting a service that takes no context, you are about to write a
 * permission hole.
 */
import { cache } from "react";
import type { Shop, WorkSession } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { businessDateFor } from "@/lib/business-date";
import { getBusinessDayStartHour } from "@/server/services/settings";
import { getAuthSession } from "./session";

/** A user's role and Purchasing permission at ONE shop (D-122). */
export interface ShopRole {
  role: "MANAGER" | "STAFF";
  canEnterCost: boolean;
}

export interface Actor {
  sessionId: string;
  userId: string;
  username: string;
  displayName: string;

  /**
   * The one role that stays global (D-122, §3.1): an owner sees and acts on
   * everything, with no shop assignment needed. MANAGER and STAFF are never
   * global — see `shopRoles`.
   */
  isOwner: boolean;

  /**
   * This actor's role and Purchasing permission at each shop they're
   * assigned to. A user can be MANAGER at one shop and STAFF at another —
   * there is no single "the" role outside a shop's context. Empty for an
   * OWNER, who needs no assignment.
   */
  shopRoles: Map<string, ShopRole>;

  isActive: boolean;
  mustChangePassword: boolean;
  defaultShopId: string | null;

  /** Today's business date, computed server-side. The client never sends this. */
  businessDate: Date;

  /** Today's declared shop, or null if the picker has not been answered yet. */
  workSession: (WorkSession & { shop: Shop }) | null;
}

/** Shop IDs this actor is assigned to. Empty for an OWNER — see §3.1. */
export function assignedShopIds(actor: Actor): string[] {
  return [...actor.shopRoles.keys()];
}

/**
 * Cost visibility gate (§7.5, CLAUDE.md, D-122).
 *
 * Whether this actor can see cost ANYWHERE — only for gating "show a cost
 * column/queue at all" before a specific shop is in scope. This must NEVER
 * gate an actual cost VALUE for a specific shop — use `canSeeCostForShop`
 * for that, always, since canEnterCost is per-shop and this flag being true
 * for one shop says nothing about another.
 */
export function canSeeCost(actor: Actor): boolean {
  if (actor.isOwner) return true;
  for (const sr of actor.shopRoles.values()) {
    if (sr.role === "MANAGER" && sr.canEnterCost) return true;
  }
  return false;
}

export function canSeeCostForShop(actor: Actor, shopId: string): boolean {
  if (actor.isOwner) return true;
  const sr = actor.shopRoles.get(shopId);
  return sr?.role === "MANAGER" && sr.canEnterCost === true;
}

/**
 * Is this actor allowed to act on this shop?
 *
 * OWNER may act on any shop and needs no assignment (§3.1). MANAGER and STAFF
 * are confined to their assignments — this is what stops a manager reaching
 * another branch by typing its ID (R-4).
 */
export function hasShopAccess(actor: Actor, shopId: string): boolean {
  return actor.isOwner || actor.shopRoles.has(shopId);
}

/** This actor's role at a specific shop, or null if OWNER or unassigned. */
export function roleAtShop(actor: Actor, shopId: string): "MANAGER" | "STAFF" | null {
  return actor.shopRoles.get(shopId)?.role ?? null;
}

/**
 * The business date to use for this actor right now.
 *
 * The start hour is GLOBAL (§4.2, C-1, D-18) — one value for the whole
 * business, read from AppSetting. It used to come from the user's default
 * shop, which was the drift D-17 recorded; that is now resolved.
 *
 * The TIMEZONE still comes from the default shop, falling back to the server
 * TZ. v1 assumes one timezone across all branches (§11), so this is a single
 * value in practice — but the shop is the more specific source, and keeping it
 * here means a future multi-timezone change has an obvious place to start.
 */
async function actorBusinessDate(defaultShop: Shop | null): Promise<Date> {
  return businessDateFor(
    new Date(),
    defaultShop?.timezone ?? process.env.TZ ?? "Asia/Jakarta",
    await getBusinessDayStartHour()
  );
}

/**
 * Load the current actor, or null when unauthenticated.
 *
 * Wrapped in React's `cache` so that a single server render resolving the
 * layout, the page and a couple of guards performs ONE session lookup rather
 * than four. The cache is per-request, so there is no cross-user bleed.
 */
export const getActor = cache(async (): Promise<Actor | null> => {
  const resolved = await getAuthSession();
  if (!resolved) return null;

  const { user, session } = resolved;

  // A deactivated user's session must stop working immediately — without this
  // check, deactivating someone would leave them signed in for up to 12 hours
  // (R-9). Better Auth also blocks new sign-ins for a banned user; this closes
  // the window on sessions that already exist.
  if (user.banned) return null;

  // Shop assignments (with per-shop role, D-122) and the default shop's
  // day-start hour are ours, not the auth library's, so they come from the
  // domain tables.
  const [memberships, defaultShop] = await Promise.all([
    prisma.userShop.findMany({
      where: { userId: user.id },
      select: { shopId: true, role: true, canEnterCost: true },
    }),
    user.defaultShopId
      ? prisma.shop.findUnique({ where: { id: user.defaultShopId } })
      : Promise.resolve(null),
  ]);

  const businessDate = await actorBusinessDate(defaultShop);

  const workSession = await prisma.workSession.findUnique({
    where: { userId_businessDate: { userId: user.id, businessDate } },
    include: { shop: true },
  });

  const shopRoles = new Map<string, ShopRole>(
    memberships.map((m) => [
      m.shopId,
      // role is constrained to MANAGER | STAFF by a DB CHECK (D-122) — OWNER
      // never gets a UserShop row.
      { role: m.role as "MANAGER" | "STAFF", canEnterCost: m.canEnterCost },
    ])
  );

  return {
    sessionId: session.id,
    userId: user.id,
    // `username` is nullable in Better Auth's schema but is always set by our
    // creation path; fall back to the synthetic-email local part rather than
    // presenting an empty string.
    username: user.username ?? user.email.split("@")[0] ?? user.id,
    displayName: user.displayName,
    isOwner: user.isOwner ?? false,
    shopRoles,
    isActive: !user.banned,
    mustChangePassword: user.mustChangePassword ?? false,
    defaultShopId: user.defaultShopId,
    businessDate,
    workSession,
  };
});

/**
 * Shops this actor may select in the day-start picker (§4.7).
 *
 * OWNER sees every active shop; everyone else sees only their assignments.
 * The HQ pseudo-shop is excluded — it accepts no sales, so nobody "works"
 * there (§4.12).
 *
 * Filtered in SQL, never in JavaScript (§5.6).
 */
export async function selectableShops(actor: Actor): Promise<Shop[]> {
  return prisma.shop.findMany({
    where: {
      isActive: true,
      isHqPseudoShop: false,
      ...(actor.isOwner
        ? {}
        : { userShops: { some: { userId: actor.userId } } }),
    },
    orderBy: [{ name: "asc" }],
  });
}

/**
 * Shops this actor may record an EXPENSE against (§4.12).
 *
 * Identical to `selectableShops` except that it **includes HQ**, which is the
 * entire point: HQ is the pseudo-shop the owner books non-branch costs to.
 *
 * Deliberately a second function rather than a flag on `selectableShops`.
 * That one feeds the day-start picker and the sale screen, where HQ must never
 * appear — it accepts no sales, and a shop in the picker is a shop someone can
 * start recording takings at. Widening it with an option would put one
 * `if` between HQ and the sale flow; a separate function cannot leak.
 *
 * HQ sorts first — it's the default landing choice for a non-branch cost,
 * and the branches a manager works at follow it alphabetically.
 */
export async function expenseShops(actor: Actor): Promise<Shop[]> {
  return prisma.shop.findMany({
    where: {
      isActive: true,
      ...(actor.isOwner
        ? {}
        : { userShops: { some: { userId: actor.userId } } }),
    },
    orderBy: [{ isHqPseudoShop: "desc" }, { name: "asc" }],
  });
}
