import { handleRoute } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { cancelLeave } from "@/server/services/schedule";

/** Cancel leave. The person's schedule resumes for those dates. */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;
    return cancelLeave(actor, id);
  });
}
