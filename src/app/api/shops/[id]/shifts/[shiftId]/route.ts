import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import {
  deleteShift,
  updateShift,
  updateShiftSchema,
} from "@/server/services/shifts";

/**
 * Edit a shift (§4.14).
 *
 * Editing times does NOT recompute past lateness — attendance rows carry their
 * own snapshot. The service is where that is enforced and explained.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; shiftId: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { shiftId } = await params;
    const input = await parseJson(req, updateShiftSchema);
    return updateShift(actor, shiftId, input);
  });
}

/** Deactivate a shift, or delete it outright when nothing references it. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; shiftId: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { shiftId } = await params;
    return deleteShift(actor, shiftId);
  });
}
