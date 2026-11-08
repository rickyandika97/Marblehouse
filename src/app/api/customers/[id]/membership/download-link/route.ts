import { requireSettledActor } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  createMembershipDownload,
  presentMembershipDownload,
} from "@/server/services/membership-download";
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const response = await handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;
    const grant = await runIdempotent(
      actor,
      parseIdempotencyKey(req),
      `POST /api/customers/${id}/membership/download-link/${actor.sessionId}`,
      (tx) => createMembershipDownload(actor, id, tx),
    );
    return presentMembershipDownload(actor, grant);
  });
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
