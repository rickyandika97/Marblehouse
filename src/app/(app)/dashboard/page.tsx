import { Suspense } from "react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { reportableShops } from "@/server/auth/context";
import { getDashboard } from "@/server/services/dashboard";
import { resolveScope } from "@/server/services/reports";
import { ReportSkeleton } from "@/components/skeleton";
import { DashboardView } from "./dashboard-view";
import type { Actor } from "@/server/auth/context";

export const metadata = { title: "Dashboard · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Dashboard (§8.3 owner / §8.4 manager).
 *
 * The permission boundary was settled in Phase 1; Phase 8 fills in the metrics.
 *
 * The service is called on the SERVER and its result handed to a presentational
 * component. That matters for more than performance: `getDashboard` returns a
 * different TYPE per role, so a manager's payload has no cost keys on it at
 * all. A client-side fetch would have shipped whatever the endpoint returned
 * and left the stripping to the component, which is the shape §7.5 forbids.
 *
 * ── D-158: THE SUSPENSE BOUNDARY IS INSIDE THE PAGE, ON PURPOSE. ──
 *
 * This is D-96's option B, finally built. **Do not replace it with a
 * `loading.tsx`** — that is the exact defect D-96 removed. A `loading.tsx`
 * wraps the whole SEGMENT, so Next flushes the shell (headers included) as a
 * 200 the moment the page suspends, in the `(app)` layout before any page code
 * runs. `forbidden()` then renders the 403 screen under a 200 status. Verified
 * still reproducible on 21 Aug 2026: adding one to `/stock` flipped a staff
 * request 403 → 200, and removing it restored 403.
 *
 * The order below is what makes streaming safe:
 *
 *   1. `requireManagerOrOwnerPage()` — may `forbidden()`
 *   2. `resolveScope()` — may `forbidden()` (wrong shop) or `notFound()` (no
 *      such shop). Cheap: no aggregates, just an access check and one lookup.
 *   3. ONLY THEN suspend, for the expensive aggregate queries.
 *
 * Both throws happen before anything suspends, so the status is already
 * settled when the shell flushes.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { shopId } = await searchParams;

  // Permission AND existence, before any boundary. `resolveScope` is what
  // stops a manager reading another branch by id (R-4) and what turns an
  // owner's typo into a 404 rather than a calm report full of zeroes.
  await resolveScope(actor, shopId ? { shopId } : {}).catch(asPageError);

  // Only an owner gets the picker (§8.3). A manager is locked to one shop
  // (§3.4), so fetching options for them would be work with nothing to show.
  // `reportableShops`, not `selectableShops`: the same question `resolveScope`
  // asks above, so the picker cannot offer a branch the guard then rejects
  // (D-177).
  const shops = (await reportableShops(actor)).map((s) => ({
    id: s.id,
    name: s.name,
  }));

  return (
    <Suspense key={shopId ?? "all"} fallback={<ReportSkeleton />}>
      <DashboardContent actor={actor} shopId={shopId} shops={shops} />
    </Suspense>
  );
}

/**
 * The slow half — every aggregate the dashboard shows.
 *
 * Split out purely so the `<Suspense>` above has something to suspend ON. The
 * page shell paints immediately and this streams in behind it.
 */
async function DashboardContent({
  actor,
  shopId,
  shops,
}: {
  actor: Actor;
  shopId: string | undefined;
  shops: Array<{ id: string; name: string }>;
}) {
  // Scope was already validated above, so this cannot be the call that decides
  // the status — it only does the expensive work.
  const dashboard = await getDashboard(actor, shopId ? { shopId } : {}).catch(
    asPageError
  );

  return <DashboardView dashboard={dashboard} shops={shops} shopId={shopId} />;
}
