import { requireManagerOrOwnerPage } from "@/server/auth/page-guard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const metadata = { title: "Dashboard · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Dashboard (§8.3 owner / §8.4 manager).
 *
 * Phase 1 establishes the ROUTE and its permission boundary only. The metrics
 * belong to Phase 8 and depend on sales, stock and attendance data that does
 * not exist yet — showing zeroes here would be indistinguishable from a
 * genuinely quiet day, which is worse than showing nothing.
 *
 * STAFF is blocked server-side. This is the address-bar test: a staff account
 * typing /dashboard gets a 403 page, not a render.
 */
export default async function DashboardPage() {
  const actor = await requireManagerOrOwnerPage();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {actor.role === "OWNER"
            ? "All shops."
            : "Your shop, one at a time."}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Nothing to report yet</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Revenue, sales, stock and attendance figures arrive with the phases
            that record them. This screen exists now so its permissions are
            settled: managers and owners reach it, staff cannot.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
