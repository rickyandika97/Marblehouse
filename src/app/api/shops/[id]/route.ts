import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { getShop, updateShop, updateShopSchema } from "@/server/services/shops";

/** `[id]`, not `[shopId]` — the sibling routes under this folder set that (D-33). */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;
    return getShop(actor, id);
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;
    const input = await parseJson(req, updateShopSchema);
    return updateShop(actor, id, input, { ipAddress: clientIp(req) });
  });
}
