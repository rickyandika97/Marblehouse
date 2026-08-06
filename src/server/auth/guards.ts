/**
 * Server-side permission guards (PRD §3.4 enforcement rule).
 *
 *   "Every one of these checks is enforced server-side, in the API layer, on
 *    every request. Hiding a button in the UI is not a permission."
 *
 * These same guards back the PAGES as well as the API, which is what makes a
 * directly-typed admin URL return 403 for a staff account rather than render.
 *
 * Guards throw AppError. Route handlers catch via `handleRoute`; pages catch
 * via `guardPage`, which renders a real 403 screen.
 */
import type { Role } from "@prisma/client";
import { getActor, hasShopAccess, type Actor } from "./context";
import { AppError, forbidden, unauthenticated } from "@/server/errors";

/** Any authenticated, active user. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) throw unauthenticated();
  return actor;
}

/**
 * An authenticated user who has completed the forced password change.
 *
 * Everything except the change-password endpoint itself should use this — a
 * user sitting on a temporary password must not be able to skip the screen by
 * calling the API directly (§5.4).
 */
export async function requireSettledActor(): Promise<Actor> {
  const actor = await requireActor();
  if (actor.mustChangePassword) {
    throw new AppError(
      "PASSWORD_CHANGE_REQUIRED",
      "You must change your password before continuing."
    );
  }
  return actor;
}

/** Restrict to an explicit set of roles. */
export async function requireRole(...roles: Role[]): Promise<Actor> {
  const actor = await requireSettledActor();
  if (!roles.includes(actor.role)) {
    throw forbidden("Your role does not have access to this area.");
  }
  return actor;
}

/** OWNER only — user admin, shops, audit, backups, profit (§3.4). */
export async function requireOwner(): Promise<Actor> {
  return requireRole("OWNER");
}

/** OWNER or MANAGER — stock, expenses, shop-scoped reporting. */
export async function requireManagerOrOwner(): Promise<Actor> {
  return requireRole("OWNER", "MANAGER");
}

/**
 * Require access to a specific shop.
 *
 * This is the check that stops a MANAGER reaching a branch outside their
 * assignments by passing its ID directly (§15 permission tests).
 */
export async function requireShopAccess(shopId: string): Promise<Actor> {
  const actor = await requireSettledActor();
  assertShopAccess(actor, shopId);
  return actor;
}

/** Non-async form, for when the actor is already loaded. */
export function assertShopAccess(actor: Actor, shopId: string): void {
  if (!hasShopAccess(actor, shopId)) {
    // Deliberately does not distinguish "no such shop" from "not yours" —
    // that difference would let a manager enumerate branch IDs.
    throw forbidden("You do not have access to that shop.");
  }
}

/**
 * Require a declared work session (§4.7).
 *
 * Any record-creating flow needs to know which shop it belongs to. Phase 2
 * onward will call this before recording a sale.
 */
export async function requireWorkSession(): Promise<
  Actor & { workSession: NonNullable<Actor["workSession"]> }
> {
  const actor = await requireSettledActor();
  if (!actor.workSession) {
    throw new AppError(
      "NO_WORK_SESSION",
      "Choose which shop you are working at today before continuing."
    );
  }
  return actor as Actor & { workSession: NonNullable<Actor["workSession"]> };
}
