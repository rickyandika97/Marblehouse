import { handleRoute } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { deleteOverride } from "@/server/services/schedule";

/**
 * Undo a single-date exception (§4.14.1).
 *
 * A real delete, unlike an assignment: an override is itself the exception, so
 * removing it simply restores whatever the pattern said. Nothing historical
 * depends on it — attendance rows record their own `scheduleSource`.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    return deleteOverride(actor, id);
  });
}
