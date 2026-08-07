import { handleRoute } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { listUncostedBatches } from "@/server/services/stock";

/**
 * The "Batches awaiting cost" queue (§7.5).
 *
 * Owner sees every shop; a Purchasing manager sees their own. A plain manager
 * gets 403 — the queue is a list of costs they may not see.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const shopId = new URL(req.url).searchParams.get("shopId") ?? undefined;
    return listUncostedBatches(actor, shopId);
  });
}
