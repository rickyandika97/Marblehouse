import { redirect } from "next/navigation";
import { getActor } from "@/server/auth/context";
import { landingPathFor } from "@/server/services/auth";
import { resolveWorkSession } from "@/server/services/work-session";

export const dynamic = "force-dynamic";

/**
 * Post-login router (§8.1).
 *
 * Resolves the landing sequence in order, server-side:
 *   1. not signed in            → /login
 *   2. mustChangePassword       → /change-password  (no way around it)
 *   3. no work session today    → /select-shop      (unless auto-selected)
 *   4. otherwise                → the role's home screen
 *
 * Step 3 has a side effect by design: a user with exactly one assigned shop
 * has it selected for them here and never sees the picker (§4.7).
 */
export default async function IndexPage() {
  const actor = await getActor();
  if (!actor) redirect("/login");

  if (actor.mustChangePassword) redirect("/change-password");

  const resolution = await resolveWorkSession(actor);
  if (resolution.needsPicker) redirect("/select-shop");

  redirect(landingPathFor(actor.role));
}
