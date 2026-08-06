import { handleRoute } from "@/server/http";
import { requireShopAccess } from "@/server/auth/guards";
import { listPresets } from "@/server/services/sales";

/**
 * Active presets for the sale screen (§7.2).
 *
 * `requireShopAccess` is the check that stops a manager or staff member reading
 * another branch's price list by passing its ID (§15 permission tests).
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const { id } = await params;
    await requireShopAccess(id);
    return { presets: await listPresets(id) };
  });
}
