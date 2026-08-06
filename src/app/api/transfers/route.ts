import { handleRoute, parseJson } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  dispatchTransfer,
  dispatchTransferSchema,
  listTransfers,
  listTransfersSchema,
} from "@/server/services/transfers";

/** Inbox of inbound and outbound transfers (§7.4, §8.7). */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { searchParams } = new URL(req.url);

    const input = listTransfersSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      status: searchParams.get("status") ?? undefined,
    });

    return listTransfers(actor, input);
  });
}

/**
 * Dispatch a transfer (§4.10 step 1).
 *
 * Idempotent: a double-tap on a slow connection must not consume the source
 * stock twice. The dispatch shares the key's transaction (D-10), so the
 * transfer and the key commit together or not at all.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, dispatchTransferSchema);

    return runIdempotent(actor, key, "POST /api/transfers", (tx) =>
      dispatchTransfer(tx, actor, input, actor.businessDate)
    );
  });
}
