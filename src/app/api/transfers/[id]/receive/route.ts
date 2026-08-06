import { handleRoute } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import { receiveTransfer } from "@/server/services/transfers";

/**
 * Confirm arrival at the destination (§4.10 step 2).
 *
 * The service checks that the actor has access to the RECEIVING shop — only
 * the destination confirms a delivery. Idempotent, so a double-tap cannot
 * create the destination batches twice.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;
    const key = parseIdempotencyKey(req);

    return runIdempotent(actor, key, `POST /api/transfers/${id}/receive`, (tx) =>
      receiveTransfer(tx, actor, id, actor.businessDate)
    );
  });
}
