import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireWorkSession } from "@/server/auth/guards";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  voidRedemption,
  voidRedemptionSchema,
} from "@/server/services/redemptions";

/**
 * Void a redemption within 24 hours (§4.9, §7.4). OWNER only.
 *
 * The role check lives in the service, not here, because the 24-hour window and
 * the restore are the same decision. Restores tickets and returns stock to the
 * exact batches it came from.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireWorkSession();
    const { id } = await params;
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, voidRedemptionSchema);
    const ipAddress = clientIp(req);

    return runIdempotent(actor, key, `POST /api/redemptions/${id}/void`, (tx) =>
      voidRedemption(actor, id, input, tx, { ipAddress })
    );
  });
}
