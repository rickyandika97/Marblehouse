import { handleRoute, parseJson, clientIp } from "@/server/http";
import {
  requireWorkSession,
  requireManagerOrOwner,
} from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  createRedemption,
  redemptionSchema,
  listRedemptions,
  listRedemptionsSchema,
} from "@/server/services/redemptions";

/** Redemption history (§7.4). Costs appear only behind the cost gate. */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { searchParams } = new URL(req.url);
    const limit = searchParams.get("limit");

    const input = listRedemptionsSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      customerId: searchParams.get("customerId") ?? undefined,
      limit: limit ? Number(limit) : undefined,
    });

    return listRedemptions(actor, input);
  });
}

/**
 * Redeem prizes for tickets (§4.9, §7.4).
 *
 * The shop comes from the work session, never the request body. Idempotent —
 * a double-tap at the counter must not redeem twice, and the whole §4.9
 * transaction shares the key's transaction (D-10).
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireWorkSession();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, redemptionSchema);
    const ipAddress = clientIp(req);

    return runIdempotent(actor, key, "POST /api/redemptions", (tx) =>
      createRedemption(actor, input, tx, { ipAddress })
    );
  });
}
