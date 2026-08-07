import { handleRoute, parseJson } from "@/server/http";
import {
  requireSettledActor,
  requireManagerOrOwner,
} from "@/server/auth/guards";
import {
  createPrize,
  createPrizeSchema,
  listPrizes,
  listPrizesSchema,
} from "@/server/services/prizes";

/**
 * Catalog for a shop, with on-hand and low-stock flags (§7.4).
 *
 * Any role may read it — staff need it to redeem. Cost fields appear only if
 * the actor passes `canSeeCostForShop`, which the service applies.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { searchParams } = new URL(req.url);

    const input = listPrizesSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      includeUnstocked: searchParams.get("includeUnstocked") === "true",
    });

    return listPrizes(actor, input);
  });
}

/** Create a catalog item, including its global ticket cost (§7.4). */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const input = await parseJson(req, createPrizeSchema);
    return createPrize(actor, input);
  });
}
