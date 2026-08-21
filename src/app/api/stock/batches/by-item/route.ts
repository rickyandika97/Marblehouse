import { handleRoute } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import {
  listBatchesForItem,
  listBatchesForItemSchema,
} from "@/server/services/stock";

/**
 * Every lot of one prize at one shop, in FIFO order (D-156).
 *
 * Distinct from `GET /api/stock/batches`, which §7.4 gates behind Purchasing
 * and which stays that way. This one is reachable by any manager at the shop
 * and the SHAPE narrows instead: without the cost gate the response carries
 * quantities and provenance and no money. See `listBatchesForItem`.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { searchParams } = new URL(req.url);

    const input = listBatchesForItemSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      prizeItemId: searchParams.get("prizeId") ?? undefined,
    });

    return listBatchesForItem(actor, input);
  });
}
