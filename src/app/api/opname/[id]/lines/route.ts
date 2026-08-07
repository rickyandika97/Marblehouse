import { handleRoute, parseJson } from "@/server/http";
import { requireManagerOrOwner } from "@/server/auth/guards";
import {
  saveOpnameLines,
  saveOpnameLinesSchema,
} from "@/server/services/opname";

/**
 * Save counted quantities and reveal the variance (§4.11, §7.4).
 *
 * This is the first point at which the system quantity is disclosed. It is
 * read server-side here rather than sent by the client, so the count cannot
 * have been anchored on it.
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;
    const input = await parseJson(req, saveOpnameLinesSchema);

    return saveOpnameLines(actor, id, input);
  });
}
