import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  listBatches,
  listBatchesSchema,
  receiveBatch,
  receiveBatchSchema,
} from "@/server/services/stock";

/** Batch list with costs — gated behind the Purchasing permission (§7.4). */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { searchParams } = new URL(req.url);

    const input = listBatchesSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      prizeItemId: searchParams.get("prizeId") ?? undefined,
      includeEmpty: searchParams.get("includeEmpty") === "true",
    });

    return listBatches(actor, input);
  });
}

/**
 * Receive stock (§7.4).
 *
 * A `unitCogs` from a caller without the Purchasing permission is a 403 from
 * the service, never a silently dropped field (§15). Idempotent because a
 * double-tap must not create two deliveries.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, receiveBatchSchema);
    const ipAddress = clientIp(req);

    return runIdempotent(actor, key, "POST /api/stock/batches", (tx) =>
      receiveBatch(actor, input, tx, { ipAddress })
    );
  });
}
