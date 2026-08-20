import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { createLeave, leaveSchema } from "@/server/services/schedule";

/**
 * Record approved leave over a date range (§4.14.2).
 *
 * The person is not prompted to clock in for those dates and is not marked
 * late. They can still clock in by giving a reason if they come in to cover —
 * leave suppresses the prompt, it never blocks the record.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const input = await parseJson(req, leaveSchema);
    return createLeave(actor, input);
  });
}
