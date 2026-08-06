import { handleRoute } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import { listPrizes, listPrizesSchema } from "@/server/services/prizes";

/**
 * Per-item on-hand and low-stock flags for a shop (§7.4).
 *
 * Any role — staff need it at the counter. This is the same projection as
 * GET /api/prizes; it exists as its own path because §7.4 names it, and
 * because the stock screen asks for stocked items only.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { searchParams } = new URL(req.url);

    const input = listPrizesSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
    });

    return listPrizes(actor, input);
  });
}
