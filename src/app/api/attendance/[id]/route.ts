import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import {
  editAttendance,
  editAttendanceSchema,
  getAttendance,
} from "@/server/services/attendance";

/** One record (§7.7). Own record, own shops, or owner — checked in the service. */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    return getAttendance(actor, id);
  });
}

/**
 * Excuse, correct or annotate (§4.13, §7.7). OWNER only.
 *
 * The role check lives in the service because the excuse rule — clearing
 * lateness — is part of the same decision.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const input = await parseJson(req, editAttendanceSchema);
    return editAttendance(actor, id, input, { ipAddress: clientIp(req) });
  });
}
