import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { selectableShops } from "@/server/auth/context";
import { getDashboard } from "@/server/services/dashboard";
import { DashboardView } from "./dashboard-view";

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
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { shopId } = await searchParams;

  // An owner may narrow to one shop; a manager's scope is resolved from their
  // work session and cannot be widened from the query string (resolveScope).
  const dashboard = await getDashboard(actor, shopId ? { shopId } : {}).catch(
    asPageError
  );

  // Only an owner gets the picker (§8.3). A manager is locked to one shop
  // (§3.4), so fetching options for them would be work with nothing to show.
  const shops = (await selectableShops(actor)).map((s) => ({ id: s.id, name: s.name }));

  return (
    <DashboardView dashboard={dashboard} shops={shops} shopId={shopId} />
  );
}
