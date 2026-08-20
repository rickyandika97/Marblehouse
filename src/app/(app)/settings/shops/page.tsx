import { requireActorPage } from "@/server/auth/page-guard";
import { selectableShops } from "@/server/auth/context";
import { listShops } from "@/server/services/shops";
import { workSessionRosterMismatch } from "@/server/services/work-session";
import { ChangeShopForm } from "./change-shop-form";
import { ShopAdmin } from "./shop-admin";

export const metadata = { title: "Shops · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Settings → Shops (§4.7, §5.6, §8.10).
 *
 * One screen for everything shop-related, split by role rather than by URL:
 * every role gets the day-start "Current shop" picker at the top, and OWNER
 * additionally gets branch administration (create, deactivate, presets,
 * shifts, staff) below it. Previously two separate tabs — Settings → Current
 * shop (all roles) and Settings → Shops (owner only) — which just made an
 * owner hunt for branch admin in a different place than the picker they use
 * every day. Merged per owner request (BUILD-LOG D-120).
 *
 * The old `/settings/shop` (singular) URL is gone, not redirected — its only
 * reference was the topbar link and the settings index, both updated.
 */
export default async function ShopsPage() {
  const actor = await requireActorPage();
  const [shops, ownerShops, rosterMismatch] = await Promise.all([
    selectableShops(actor),
    actor.isOwner ? listShops(actor) : Promise.resolve(null),
    workSessionRosterMismatch(actor),
  ]);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Shops</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {actor.isOwner
            ? "Pick today's shop, add a branch, or change its options and late grace."
            : "Choose today's shop. Changing this does not move records you have already made today, and every change is recorded in the audit log."}
        </p>
      </div>

      <section className="space-y-3">
        {actor.isOwner && (
          <h2 className="text-lg font-semibold tracking-tight">
            Current shop
          </h2>
        )}
        <ChangeShopForm
          shops={shops.map((s) => ({ id: s.id, code: s.code, name: s.name }))}
          currentShopId={actor.workSession?.shopId ?? null}
        />
        {rosterMismatch && (
          <p className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            Your timetable places you at {rosterMismatch.name} today. Your
            current shop has not been changed automatically — keep it for cover
            work, or change it above before recording new items.
          </p>
        )}
      </section>

      {ownerShops && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">
            Your branches
          </h2>
          <ShopAdmin initialShops={ownerShops} />
        </section>
      )}
    </div>
  );
}
