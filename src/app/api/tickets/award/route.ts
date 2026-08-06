import { requireWorkSession } from "@/server/auth/guards";
import { handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import { awardTickets, ticketAwardSchema } from "@/server/services/tickets";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireWorkSession();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, ticketAwardSchema);
    return runIdempotent(actor, key, "POST /api/tickets/award", (tx) =>
      awardTickets(actor, input, tx)
    );
  });
}

