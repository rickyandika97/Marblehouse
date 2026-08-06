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

  return (
    <AppShell
      displayName={actor.displayName}
      role={actor.role}
      shopName={shopName}
    >
      {children}
    </AppShell>
  );
}
