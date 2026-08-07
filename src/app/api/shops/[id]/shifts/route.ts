import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import {
  createShift,
  listShifts,
  shiftSchema,
} from "@/server/services/shifts";
import { listShiftsForToday } from "@/server/services/attendance";

/**
 * Shifts at a shop (§7.7).
 *
 * `?today=true` returns only the shifts running today, each annotated with
 * whether clocking in now would be late — that is what the §8.9 chooser needs.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id: shopId } = await params;

    return new URL(req.url).searchParams.get("today") === "true"
      ? listShiftsForToday(actor, shopId)
      : listShifts(actor, shopId);
  });
}

/** Create a shift (§4.14). Owner, or a manager at their own shop. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id: shopId } = await params;
    const input = await parseJson(req, shiftSchema);
    return createShift(actor, shopId, input);
  });
}
