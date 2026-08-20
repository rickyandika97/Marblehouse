import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import {
  removeAssignment,
  updateAssignment,
  updateAssignmentSchema,
} from "@/server/services/schedule";

/** Change a recurring assignment's days (§4.14.1). */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    const input = await parseJson(req, updateAssignmentSchema);
    return updateAssignment(actor, id, input);
  });
}

/**
 * Remove a schedule — the person no longer works this shift (D-140).
 *
 * A SOFT delete: hidden from the roster, kept as the record behind any past
 * attendance. Not the tool for a holiday — that is `POST /api/schedule/leave`.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    return removeAssignment(actor, id);
  });
}
