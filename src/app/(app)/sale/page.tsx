import { redirect } from "next/navigation";
import { requireActorPage } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import { listPresets, todaySummary } from "@/server/services/sales";
import { SaleForm } from "./sale-form";

export const metadata = { title: "Sale · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Record a sale (§8.2) — the landing route for MANAGER and STAFF (§8.0).
 *
 * Presets and today's totals are fetched on the server so the screen is usable
 * on first paint: staff open this at the start of a shift on shop wifi, and a
 * client-side fetch waterfall would show them an empty grid for a second.
 */
export default async function SalePage() {
  const actor = await requireActorPage();

  // Resolve the session HERE rather than trusting `actor.workSession`.
  //
  // `getActor` is wrapped in React's per-request `cache`, so for a single-shop
  // user the actor was loaded (workSession: null) BEFORE the layout
  // auto-selected their only shop — and the cached copy never learns about it.
  // Reading the cached value would throw NO_WORK_SESSION on the one path §4.7
  // promises is seamless. `resolveWorkSession` is idempotent, so calling it
  // again is free.
  const { session } = await resolveWorkSession(actor);
  if (!session) redirect("/select-shop");

  const working = { ...actor, workSession: session };

  const [presets, summary] = await Promise.all([
    listPresets(session.shopId),
    todaySummary(working),
  ]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Record a sale</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {session.shop.name} · {summary.businessDate}
        </p>
      </div>

      {presets.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          This shop has no sale prices set up yet. The owner can add them in
          Settings → Shops.
        </div>
      ) : (
        <SaleForm
          presets={presets}
          allowCustomAmount={session.shop.allowCustomAmount}
          initialSummary={summary}
          shopId={session.shopId}
        />
      )}
    </div>
  );
}
