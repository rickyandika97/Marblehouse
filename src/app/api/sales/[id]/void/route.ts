import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import { voidSale, voidSaleSchema } from "@/server/services/sales";

/**
 * Void a sale (§7.2, §4.3).
 *
 * Role and same-business-day rules live in the service, because they depend on
 * the sale being voided — a handler cannot know them from the request alone.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const input = await parseJson(req, voidSaleSchema);

    return voidSale(actor, id, input, { ipAddress: clientIp(req) });
  });
}
