/**
 * Page-level guards for server components.
 *
 * The acceptance criterion for Phase 1 is that a STAFF account typing an admin
 * URL into the address bar is BLOCKED — "not just a hidden button" (§3.4).
 *
 * These wrap the same guards the API uses, so a page and its endpoint can
 * never disagree about who is allowed in. A denied page renders a real 403
 * screen rather than redirecting: a redirect would imply the URL is fine and
 * the user merely logged in wrong.
 */
import { forbidden, notFound, redirect } from "next/navigation";
import { AppError } from "@/server/errors";
import { getActor, type Actor } from "./context";

/**
 * Require an authenticated, settled actor for a page.
 *
 * Unauthenticated → /login. Flagged mustChangePassword → the forced change
 * screen, from which there is no way around (§5.4).
 */
export async function requireActorPage(
  opts: { allowUnsettled?: boolean } = {}
): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");

  if (actor.mustChangePassword && !opts.allowUnsettled) {
    redirect("/change-password");
  }

  return actor;
}

/**
 * Require OWNER for a page.
 *
 * This is the server-side check behind the address-bar test. It runs before
 * any markup is produced, so the protected page never renders at all.
 */
export async function requireOwnerPage(): Promise<Actor> {
  const actor = await requireActorPage();
  if (!actor.isOwner) {
    // Returns a real HTTP 403 and renders forbidden.tsx. Not a redirect: a
    // redirect would imply the URL is fine and they merely signed in wrong.
    forbidden();
  }
  return actor;
}

/**
 * OWNER, or MANAGER at the given shop (D-122 — role is per-shop). Use this,
 * not `requireManagerOrOwnerPage`, whenever the page already knows which
 * shop it's about.
 */
export async function requireShopRolePage(
  shopId: string,
  ...roles: ("MANAGER" | "STAFF")[]
): Promise<Actor> {
  const actor = await requireActorPage();
  if (actor.isOwner) return actor;
  const sr = actor.shopRoles.get(shopId);
  if (!sr || !roles.includes(sr.role)) {
    forbidden();
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
export async function requireManagerOrOwnerPage(): Promise<Actor> {
  const actor = await requireActorPage();
  const isManagerSomewhere = [...actor.shopRoles.values()].some(
    (sr) => sr.role === "MANAGER"
  );
  if (!actor.isOwner && !isManagerSomewhere) {
    forbidden();
  }
  return actor;
}

/**
 * Convert an AppError thrown by a service into the right page-level response.
 *
 * A service throws `AppError` (CLAUDE.md rule 10) and `handleRoute` converts it
 * for API routes. A PAGE has no such wrapper, so an uncaught throw becomes a
 * 500 — which is how two Phase 8 report pages returned a server error to a
 * plain manager instead of a 403 (D-64).
 *
 * Only the codes a page can genuinely produce are mapped. Anything else is
 * rethrown deliberately: a service failing in a way a page did not anticipate
 * IS a 500, and silently rendering "not found" for it would hide a real bug.
 */
export function asPageError(e: unknown): never {
  if (e instanceof AppError) {
    if (e.code === "FORBIDDEN") forbidden();
    // A bad shop id in the URL bar. Without this it is a 500; with it the
    // user gets the standard not-found page.
    if (e.code === "NOT_FOUND") notFound();
  }
  throw e;
}
