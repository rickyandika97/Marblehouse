import { handleRoute, parseJson } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  cancelTransfer,
  cancelTransferSchema,
} from "@/server/services/transfers";

/**
 * Cancel a transfer while it is IN_TRANSIT (§4.10).
 *
 * A reason is mandatory (D-38) and audit-logged: a cancel after the box has
 * physically left is exactly the case worth a paper trail, and it is
 * indistinguishable from a mis-keyed dispatch without one. The service checks
 * access to the SOURCE shop, which is the end getting its stock back.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, cancelTransferSchema);

    return runIdempotent(actor, key, `POST /api/transfers/${id}/cancel`, (tx) =>
      cancelTransfer(tx, actor, id, input.reason, actor.businessDate)
    );
  });
}
