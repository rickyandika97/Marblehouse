import { redirect } from "next/navigation";
import { requireActorPage } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { AppShell } from "@/components/app-shell";

export const dynamic = "force-dynamic";

/**
 * Authenticated shell (§8.0).
 *
 * Every page inside (app) is guarded here as well as in itself — this layout
 * settles identity and the work session, and each page re-checks its own role.
 * Defence in depth: a layout is not a permission either.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const actor = await requireActorPage();

  // No shop declared for today → the picker, before anything can be recorded.
  const resolution = await resolveWorkSession(actor);
  if (resolution.needsPicker) redirect("/select-shop");

  const shopName =
    resolution.session?.shop.name ?? actor.workSession?.shop.name ?? null;

  const isManagerSomewhere = [...actor.shopRoles.values()].some(
    (sr) => sr.role === "MANAGER"
  );

  return (
    <AppShell
      displayName={actor.displayName}
      isOwner={actor.isOwner}
      isManagerSomewhere={isManagerSomewhere}
      shopName={shopName}
    >
      {children}
    </AppShell>
  );
}
