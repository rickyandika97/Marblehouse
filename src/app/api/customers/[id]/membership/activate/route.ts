import { requireSettledActor } from "@/server/auth/guards";
import { handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  activateMembership,
  activateMembershipSchema,
} from "@/server/services/membership";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const response = await handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    await parseJson(req, activateMembershipSchema);
    return runIdempotent(
      actor,
      parseIdempotencyKey(req),
      `POST /api/customers/${id}/membership/activate`,
      (tx) => activateMembership(actor, id, tx),
    );
  });
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}
