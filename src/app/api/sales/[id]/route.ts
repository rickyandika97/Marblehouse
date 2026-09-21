import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import { updateSale, updateSaleSchema } from "@/server/services/sales";

/**
 * Edit a sale (D-181). OWNER only — the check is in the service, because a
 * route handler authenticates and validates and nothing else (architecture
 * rule 1), and because every caller of `updateSale` must be covered, not only
 * this one.
 *
 * `businessDate` is deliberately absent from the accepted body: it is derived
 * server-side from `occurredAt` and the target shop's timezone (§6.1.4, D-18).
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const input = await parseJson(req, updateSaleSchema);

    return updateSale(actor, id, input, { ipAddress: clientIp(req) });
  });
}
