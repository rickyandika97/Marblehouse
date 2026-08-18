import { handleRoute, parseJson, clientIp } from "@/server/http";
import { requireOwner } from "@/server/auth/guards";
import {
  deletePreset,
  updatePreset,
  updatePresetSchema,
} from "@/server/services/shops";

/**
 * Edit or remove one sale price (§7.2, §4.3). OWNER only.
 *
 * A PATCH that changes the amount of a preset with sales against it does NOT
 * edit the row — it supersedes it. The response carries `supersededId` when
 * that happened. See `updatePreset`.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string; presetId: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id, presetId } = await params;
    const input = await parseJson(req, updatePresetSchema);
    return updatePreset(actor, id, presetId, input, { ipAddress: clientIp(req) });
  });
}

/** Only ever succeeds for a preset no sale references (§13.5). */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string; presetId: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const { id, presetId } = await params;
    return deletePreset(actor, id, presetId, { ipAddress: clientIp(req) });
  });
}
