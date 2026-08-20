import { requireWorkSession } from "@/server/auth/guards";
import { clientIp, handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import { forbidden } from "@/server/errors";
import { adjustTickets, ticketAdjustSchema } from "@/server/services/tickets";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireWorkSession();
    if (!actor.isOwner && actor.shopRoles.get(actor.workSession.shopId)?.role !== "MANAGER") {
      throw forbidden("Only a manager or the owner can correct a ticket balance.");
    }
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, ticketAdjustSchema);
    return runIdempotent(actor, key, "POST /api/tickets/adjust", (tx) =>
      adjustTickets(actor, input, tx, { ipAddress: clientIp(req) })
    );
  });
}

