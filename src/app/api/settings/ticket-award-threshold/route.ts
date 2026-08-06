import { requireOwner } from "@/server/auth/guards";
import { clientIp, handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  getTicketAwardReasonThreshold,
  updateTicketAwardReasonThreshold,
  updateTicketAwardReasonThresholdSchema,
} from "@/server/services/settings";

export async function GET() {
  return handleRoute(async () => {
    await requireOwner();
    return { threshold: await getTicketAwardReasonThreshold() };
  });
}

export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, updateTicketAwardReasonThresholdSchema);
    return runIdempotent(
      actor,
      key,
      "PATCH /api/settings/ticket-award-threshold",
      (tx) =>
        updateTicketAwardReasonThreshold(actor, input.threshold, tx, {
          ipAddress: clientIp(req),
        })
    );
  });
}

