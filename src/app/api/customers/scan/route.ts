import { requireSettledActor } from "@/server/auth/guards";
import { handleRoute, parseJson } from "@/server/http";
import { runIdempotent, parseIdempotencyKey } from "@/server/idempotency";
import {
  scanMembership,
  scanMembershipSchema,
} from "@/server/services/membership";
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const input = await parseJson(req, scanMembershipSchema);
    return runIdempotent(
      actor,
      parseIdempotencyKey(req),
      `POST /api/customers/scan/${actor.sessionId}`,
      (tx) => scanMembership(actor, input, tx),
    );
  });
}
