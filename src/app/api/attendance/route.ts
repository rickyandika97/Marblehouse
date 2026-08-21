import { handleRoute } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import {
  listAttendance,
  listAttendanceSchema,
} from "@/server/services/attendance";

/**
 * Attendance records (§7.7).
 *
 * Scoping is applied in the service as a SQL filter the caller cannot widen:
 * STAFF see only themselves, a MANAGER only their assigned shops.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { searchParams } = new URL(req.url);

    const input = listAttendanceSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      userId: searchParams.get("userId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
      lateOnly: searchParams.get("lateOnly") === "true" ? true : undefined,
      arrival: searchParams.get("arrival") ?? undefined,
      q: searchParams.get("q") ?? undefined,
      outsideSchedule:
        searchParams.get("outsideSchedule") === "true" ? true : undefined,
    });

    return listAttendance(actor, input);
  });
}
