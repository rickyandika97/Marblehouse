import { handleRoute } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { attendanceStatus } from "@/server/services/attendance";

/** Drives the §4.13 red banner. Any authenticated user reads their own state. */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireActor();
    return attendanceStatus(actor);
  });
}
