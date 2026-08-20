import { requireActorPage } from "@/server/auth/page-guard";
import {
  listAttendance,
  listAttendanceAttention,
} from "@/server/services/attendance";
import { AttendanceReport, type AttendanceReportSearchParams } from "./attendance-report";
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
export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    attention?: string;
    view?: string;
  } & AttendanceReportSearchParams>;
}) {
  const sp = await searchParams;
  if (sp.view === "report") return <AttendanceReport searchParams={sp} />;

  const actor = await requireActorPage();
  const { attention, shopId } = sp;

  const isManagerSomewhere = [...actor.shopRoles.values()].some(
    (sr) => sr.role === "MANAGER"
  );
  const canSeeTeam = actor.isOwner || isManagerSomewhere;
  const [myRows, teamRows] = await Promise.all([
    actor.isOwner ? Promise.resolve([]) : listAttendance(actor, { mineOnly: true }),
    canSeeTeam ? listAttendance(actor, {}) : Promise.resolve([]),
  ]);
  const issue =
    attention === "not-clocked-in" || attention === "late" ? attention : null;
  const attentionRows = issue
    ? await listAttendanceAttention(actor, {
        issue,
        ...(shopId ? { shopId } : {}),
      })
    : null;

  return (
    <AttendanceList
      myRows={myRows}
      teamRows={teamRows}
      canSeeTeam={canSeeTeam}
      showMyAttendance={!actor.isOwner}
      canExcuse={actor.isOwner}
      selfUserId={actor.userId}
      attention={
        issue
          ? {
              issue,
              rows: attentionRows ?? [],
            }
          : null
      }
    />
  );
}
