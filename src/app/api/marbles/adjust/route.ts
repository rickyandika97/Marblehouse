import { requireWorkSession } from "@/server/auth/guards";
import { clientIp, handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import { adjustMarbles, marbleAdjustSchema } from "@/server/services/marbles";
import { forbidden } from "@/server/errors";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireWorkSession();
    if (actor.role === "STAFF") {
      throw forbidden("Only a manager or the owner can correct a marble balance.");
    }
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, marbleAdjustSchema);
    return runIdempotent(actor, key, "POST /api/marbles/adjust", (tx) =>
      adjustMarbles(actor, input, tx, { ipAddress: clientIp(req) })
    );
  });
}

