import { requireActorPage } from "@/server/auth/page-guard";
import { listAttendance } from "@/server/services/attendance";
import { AttendanceList } from "./attendance-list";

export const metadata = { title: "Attendance · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Attendance (§8.9).
 *
 * "My attendance" for everyone; a manager and the owner also see their team,
 * because `listAttendance` widens the SQL scope by role rather than by any
 * parameter the client can send.
 *
 * The ranked lateness table and the calendar heatmap that §8.9 also describes
 * are reporting surfaces and belong with the other reports in Phase 8 — this
 * screen ships the history and the detail, which is what Phase 6 owns.
 */
export default async function AttendancePage() {
  const actor = await requireActorPage();
  const rows = await listAttendance(actor, {});

  return (
    <AttendanceList
      rows={rows}
      canSeeTeam={actor.role !== "STAFF"}
      canExcuse={actor.role === "OWNER"}
      selfUserId={actor.userId}
    />
  );
}
