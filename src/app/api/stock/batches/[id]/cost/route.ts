import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { setBatchCost, setBatchCostSchema } from "@/server/services/stock";

/**
 * Price an uncosted batch and backfill the history it touched (§7.4, §7.5).
 *
 * Owner, or a Purchasing manager at one of their own shops. The service runs
 * the backfill and the audit row in one transaction.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;
    const input = await parseJson(req, setBatchCostSchema);
    return setBatchCost(actor, id, input, { ipAddress: clientIp(req) });
  });
}
