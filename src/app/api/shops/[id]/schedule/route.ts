import { handleRoute, parseJson } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import {
  assignmentSchema,
  createAssignment,
  listAssignments,
  listLeave,
  resolveDay,
  resolveWeek,
} from "@/server/services/schedule";

/**
 * The timetable at a shop (§4.14.1).
 *
 *   ?week=YYYY-MM-DD  → seven resolved days, for the roster grid.
 *   ?date=YYYY-MM-DD  → one resolved day: who is rostered, pattern + overrides.
 *   (neither)         → the raw recurring assignments, for the edit screen.
 *
 * The resolved views are DERIVED and read-only. Nothing stores a week; the
 * pattern plus its overrides is the only source of truth, which is what keeps
 * "edit next Tuesday" from silently changing every Tuesday.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id: shopId } = await params;
    const q = new URL(req.url).searchParams;

    const week = q.get("week");
    if (week) return resolveWeek(actor, shopId, week);

    if (q.get("leave") === "true") return listLeave(actor, shopId);

    const date = q.get("date");
    if (date) {
      const [y, m, d] = date.split("-").map(Number) as [number, number, number];
      return resolveDay(actor, shopId, new Date(Date.UTC(y, m - 1, d)));
    }

    return listAssignments(actor, shopId, {
      includeRemoved: q.get("includeRemoved") === "true",
    });
  });
}

/** Roster someone onto a recurring shift. Owner, or a manager at this shop. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id: shopId } = await params;
    const input = await parseJson(req, assignmentSchema);
    return createAssignment(actor, shopId, input);
  });
}
