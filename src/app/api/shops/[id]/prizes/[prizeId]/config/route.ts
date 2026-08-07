import { handleRoute, parseJson } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import {
  setShopPrizeConfig,
  shopPrizeConfigSchema,
} from "@/server/services/prizes";

/**
 * Per-shop stocking policy (§7.4).
 *
 * `{ lowStockThreshold, isActive }` only. Ticket cost is global and is NOT
 * settable here — the schema is strict, so a request carrying one is rejected
 * rather than having the field silently stripped.
 *
 * The slug is `[id]`, not `[shopId]`, because Next requires ONE slug name per
 * path segment across the whole tree and `/api/shops/[id]/presets` (Phase 2)
 * claimed it first. Renaming that one would have changed a shipped endpoint's
 * folder for cosmetics.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string; prizeId: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id: shopId, prizeId } = await params;
    const input = await parseJson(req, shopPrizeConfigSchema);
    return setShopPrizeConfig(actor, shopId, prizeId, input);
  });
}
