import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireShopAccess, requireOwner } from "@/server/auth/guards";
import { listPresets } from "@/server/services/sales";
import {
  addDefaultPresets,
  createPreset,
  createPresetSchema,
  listPresetsForAdmin,
} from "@/server/services/shops";

/**
 * Presets for this shop (§7.2).
 *
 * Two audiences, one URL, decided by `?admin=1`:
 *
 *  - default — the SALE SCREEN's list: active presets only, no use counts,
 *    readable by anyone with access to the shop.
 *  - `?admin=1` — the owner's management list: active AND inactive, each with
 *    the number of sales against it. OWNER only.
 *
 * The two are separate guards on purpose. Staff must keep reading the price
 * list (they cannot ring up a sale otherwise), and must not learn which prices
 * were retired or how often each is used.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const { id } = await params;

    if (new URL(req.url).searchParams.get("admin") === "1") {
      const actor = await requireOwner();
      return { presets: await listPresetsForAdmin(actor, id) };
    }

    await requireShopAccess(id);
    return { presets: await listPresets(id) };
  });
}

/**
 * Add a price, or seed the five defaults on an empty branch.
 *
 * `{ "defaults": true }` is the empty-branch shortcut; anything else is a
 * single preset. Both are OWNER-only (§3.4 "Edit shop sale presets").
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id } = await params;

    const body: unknown = await req.clone().json().catch(() => null);
    if (body && typeof body === "object" && "defaults" in body && body.defaults === true) {
      return { presets: await addDefaultPresets(actor, id, { ipAddress: clientIp(req) }) };
    }

    const input = await parseJson(req, createPresetSchema);
    return createPreset(actor, id, input, { ipAddress: clientIp(req) });
  });
}
