import { requireSettledActor } from "@/server/auth/guards";
import { handleRoute, parseJson } from "@/server/http";
import { runIdempotent, parseIdempotencyKey } from "@/server/idempotency";
import {
  getMembershipCard,
  replaceMembershipCard,
  replaceMembershipSchema,
} from "@/server/services/membership";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    return Response.json(await getMembershipCard(actor, id), {
      headers: { "Cache-Control": "no-store, private" },
    });
  });
}
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const input = await parseJson(req, replaceMembershipSchema);
    return runIdempotent(
      actor,
      parseIdempotencyKey(req),
      `POST /api/customers/${id}/membership`,
      (tx) => replaceMembershipCard(actor, id, input, tx),
    );
  });
}
