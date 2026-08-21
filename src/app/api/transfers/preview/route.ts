import { handleRoute, parseJson } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import {
  previewTransferPlan,
  previewTransferSchema,
} from "@/server/services/transfers";

/**
 * Dry run of a dispatch (D-156): which lots FIFO would draw, without drawing
 * them.
 *
 * POST because it carries a body of lines, but it WRITES NOTHING — hence no
 * `Idempotency-Key` and no `runIdempotent` wrapper. Replaying it is free; a
 * preview is a forecast, not a reservation, and dispatch re-runs FIFO for real.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const input = await parseJson(req, previewTransferSchema);

    return previewTransferPlan(actor, input);
  });
}
