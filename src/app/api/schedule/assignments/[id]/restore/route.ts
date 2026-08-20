import { handleRoute } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { restoreAssignment } from "@/server/services/schedule";

/**
 * Undo a removal (§4.14.1, D-140).
 *
 * Its own endpoint rather than a PATCH, because it re-checks that the shift is
 * still active and the person still works here — a schedule must not come back
 * pointing at something that no longer exists.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    return restoreAssignment(actor, id);
  });
}
