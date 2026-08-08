/** §7.8 GET /api/dashboard — role-shaped dashboard payload (§8.3, §8.4). */
import { requireManagerOrOwner } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import { getDashboard } from "@/server/services/dashboard";
import { reportRangeSchema } from "@/server/services/reports";

export async function GET(req: Request) {
  return handleRoute(async () => {
    // STAFF is refused here AND again inside getDashboard — the service must
    // hold its own line, because a service is one caller away from a route
    // that forgot (D-55).
    const actor = await requireManagerOrOwner();
    const { searchParams } = new URL(req.url);
    const input = reportRangeSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
    });
    return getDashboard(actor, input);
  });
}
