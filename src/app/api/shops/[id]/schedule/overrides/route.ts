import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { createOverride, overrideSchema } from "@/server/services/schedule";

/**
 * Add a single-date exception to the roster (§4.14.1): leave, a swap, or an
 * extra body on a busy day. Always carries a reason.
 *
 * Upserts on (user, shift, date) — a second decision about the same slot
 * replaces the first rather than stacking a contradictory pair.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id: shopId } = await params;
    const input = await parseJson(req, overrideSchema);
    return createOverride(actor, shopId, input);
  });
}
