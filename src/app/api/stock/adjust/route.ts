import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import { adjustStock, adjustStockSchema } from "@/server/services/stock";

/**
 * Manual stock adjustment with a mandatory reason (§7.4, §4.16).
 *
 * A negative delta consumes FIFO so the cost basis stays honest; a positive one
 * creates an adjustment batch awaiting cost.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, adjustStockSchema);
    const ipAddress = clientIp(req);

    return runIdempotent(actor, key, "POST /api/stock/adjust", (tx) =>
      adjustStock(actor, input, tx, { ipAddress })
    );
  });
}
