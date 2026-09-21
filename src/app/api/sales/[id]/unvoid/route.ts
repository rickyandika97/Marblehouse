import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import { unvoidSale, unvoidSaleSchema } from "@/server/services/sales";

/**
 * Restore a voided sale (D-181). OWNER only, enforced in the service.
 *
 * A sibling of `void/route.ts` rather than a `status` field on the PATCH
 * above: reversing a reversal is its own act, it writes its own audit action,
 * and it is the one thing an edit must never do by accident.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const input = await parseJson(req, unvoidSaleSchema);

    return unvoidSale(actor, id, input, { ipAddress: clientIp(req) });
  });
}
