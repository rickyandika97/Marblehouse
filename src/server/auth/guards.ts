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

/** OWNER only — employee admin, shops, audit, backups, profit (§3.4). */
export async function requireOwner(): Promise<Actor> {
  const actor = await requireSettledActor();
  if (!actor.isOwner) {
    throw forbidden("Your role does not have access to this area.");
  }
  return actor;
}

/**
 * OWNER, or MANAGER at the given shop (D-122 — role is per-shop, so a
 * "manager or owner" check is only meaningful once a shop is known).
 *
 * This is the check that stops a MANAGER reaching a branch outside their
 * assignments, or acting with MANAGER privileges at a shop where they only
 * hold STAFF, by passing an ID directly (§15 permission tests).
 */
export async function requireShopRole(
  shopId: string,
  ...roles: ("MANAGER" | "STAFF")[]
): Promise<Actor> {
  const actor = await requireSettledActor();
  if (actor.isOwner) return actor;
  const sr = actor.shopRoles.get(shopId);
  if (!sr || !roles.includes(sr.role)) {
    throw forbidden("Your role does not have access to this shop.");
  }
  return actor;
}

/**
 * OWNER, or MANAGER at ANY shop — a COARSE PRE-FILTER, never a permission.
 *
 * **This does not authorise any particular shop's data (D-138).** Role is
 * per-shop: a user who is MANAGER at branch A and STAFF at branch B passes
 * this, and if the caller then resolves a shop independently it can resolve
 * to B. That was a real defect — it rendered B's manager dashboard to
 * someone who only staffs B.
 *
 * It survives only to fail fast for a pure-STAFF account on screens with no
 * shop in scope yet. Every service behind it MUST re-check the role against
 * the shop that actually resolves — `resolveScope(..., { requireManagerAt:
 * true })` is how the report and dashboard paths do it. Never let this be the
 * only role check between a request and a shop's money.
 */
export async function requireManagerOrOwner(): Promise<Actor> {
  const actor = await requireSettledActor();
  const isManagerSomewhere = [...actor.shopRoles.values()].some(
    (sr) => sr.role === "MANAGER"
  );
  if (!actor.isOwner && !isManagerSomewhere) {
    throw forbidden("Your role does not have access to this area.");
  }
  return actor;
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
