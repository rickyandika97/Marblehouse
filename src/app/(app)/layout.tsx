import { redirect } from "next/navigation";
import { requireActorPage } from "@/server/auth/page-guard";
import { selectableShops } from "@/server/auth/context";
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
  const [resolution, shops] = await Promise.all([
    resolveWorkSession(actor),
    selectableShops(actor),
  ]);
  if (resolution.needsPicker) redirect("/select-shop");

  const shopName =
    resolution.session?.shop.name ?? actor.workSession?.shop.name ?? null;

  // The nav reflects the role AT TODAY'S SHOP, not "manager somewhere"
  // (D-138). Someone who manages branch A but only staffs branch B must get
  // the staff nav on a day they are working at B — showing them the manager
  // tabs there advertises screens the server now (correctly) refuses, which
  // reads as a broken app rather than as a permission.
  const todayShopId =
    resolution.session?.shopId ?? actor.workSession?.shopId ?? null;
  const isManagerHere = todayShopId
    ? actor.shopRoles.get(todayShopId)?.role === "MANAGER"
    : false;

  return (
    <AppShell
      displayName={actor.displayName}
      isOwner={actor.isOwner}
      isManagerHere={isManagerHere}
      shopName={shopName}
      shopId={todayShopId}
      shops={shops.map((shop) => ({
        id: shop.id,
        code: shop.code,
        name: shop.name,
      }))}
    >
      {children}
    </AppShell>
  );
}
