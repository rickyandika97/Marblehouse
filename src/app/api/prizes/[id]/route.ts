import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { updatePrize, updatePrizeSchema } from "@/server/services/prizes";

/**
 * Update a catalog item (§7.4).
 *
 * Changing `ticketCost` changes the price at EVERY branch (§4.8) — the service
 * audit-logs it and raises an owner alert.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;
    const input = await parseJson(req, updatePrizeSchema);
    return updatePrize(actor, id, input, { ipAddress: clientIp(req) });
  });
}
