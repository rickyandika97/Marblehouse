import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import { createShop, createShopSchema, listShops } from "@/server/services/shops";

export async function GET() {
  return handleRoute(async () => {
    const actor = await requireOwner();
    return { shops: await listShops(actor) };
  });
}

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const input = await parseJson(req, createShopSchema);
    return createShop(actor, input, { ipAddress: clientIp(req) });
  });
}
