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
import { forbidden, redirect } from "next/navigation";
import type { Role } from "@prisma/client";
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
 * Require one of the given roles for a page.
 *
 * This is the server-side check behind the address-bar test. It runs before
 * any markup is produced, so the protected page never renders at all.
 */
export async function requireRolePage(...roles: Role[]): Promise<Actor> {
  const actor = await requireActorPage();

  if (!roles.includes(actor.role)) {
    // Returns a real HTTP 403 and renders forbidden.tsx. Not a redirect: a
    // redirect would imply the URL is fine and they merely signed in wrong.
    forbidden();
  }

  return actor;
}

export async function requireOwnerPage(): Promise<Actor> {
  return requireRolePage("OWNER");
}

export async function requireManagerOrOwnerPage(): Promise<Actor> {
  return requireRolePage("OWNER", "MANAGER");
}

/** Convert an AppError thrown by a service into a page-level 403. */
export function asPageError(e: unknown): never {
  if (e instanceof AppError && e.code === "FORBIDDEN") {
    forbidden();
  }
  throw e;
}
