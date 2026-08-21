import { requireActorPage } from "@/server/auth/page-guard";
import { selectableShops } from "@/server/auth/context";
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
    q?: string;
    arrival?: "late" | "early";
    outsideSchedule?: string;
  } & AttendanceReportSearchParams>;
}) {
  const sp = await searchParams;
  if (sp.view === "report") return <AttendanceReport searchParams={sp} />;

  const actor = await requireActorPage();
  const { attention, shopId } = sp;
  const listInput = {
    ...(shopId ? { shopId } : {}),
    ...(sp.from ? { from: sp.from } : {}),
    ...(sp.to ? { to: sp.to } : {}),
    ...(sp.arrival ? { arrival: sp.arrival } : {}),
    ...(sp.q ? { q: sp.q } : {}),
    ...(sp.outsideSchedule === "true" ? { outsideSchedule: true } : {}),
  };

  const isManagerSomewhere = [...actor.shopRoles.values()].some(
    (sr) => sr.role === "MANAGER"
  );
  const canSeeTeam = actor.isOwner || isManagerSomewhere;
  const [myRows, teamRows, shops] = await Promise.all([
    actor.isOwner ? Promise.resolve([]) : listAttendance(actor, { mineOnly: true, ...listInput }),
    canSeeTeam ? listAttendance(actor, listInput) : Promise.resolve([]),
    selectableShops(actor),
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
      filters={{
        ...listInput,
        shops: shops.map((shop) => ({ id: shop.id, name: shop.name })),
        businessDate: actor.businessDate.toISOString().slice(0, 10),
      }}
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
