import { requireOwner } from "@/server/auth/guards";
import { clientIp, handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import {
  getBusinessDayStartHour,
  updateBusinessDayStartHour,
  updateBusinessDayStartHourSchema,
} from "@/server/services/settings";

export async function GET() {
  return handleRoute(async () => {
    await requireOwner();
    return { hour: await getBusinessDayStartHour() };
  });
}

/** §8.10. Changing this does NOT restamp history — see D-18 and the service. */
export async function PATCH(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, updateBusinessDayStartHourSchema);
    return runIdempotent(
      actor,
      key,
      "PATCH /api/settings/business-day-start-hour",
      (tx) =>
        updateBusinessDayStartHour(actor, input.hour, tx, {
          ipAddress: clientIp(req),
        })
    );
  });
}
