import { redirect } from "next/navigation";
import { requireActorPage } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import {
  attendanceStatus,
  listShiftsForToday,
} from "@/server/services/attendance";
import { myScheduleToday, resolveDay } from "@/server/services/schedule";
import { landingPathFor } from "@/server/services/auth";
import { ClockInFlow } from "./clock-in-flow";

export const metadata = { title: "Clock in · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Clock-in (§8.9).
 *
 * The shop comes from the work session, so this page redirects to the picker
 * rather than letting anyone choose a branch here — an attendance record at the
 * wrong branch is worse than one that is a minute late.
 */
export default async function ClockInPage() {
  const actor = await requireActorPage();

  const { session } = await resolveWorkSession(actor);
  if (!session) redirect("/select-shop");

  /**
   * Both lists, deliberately (§4.14.1).
   *
   * `mine` is what the roster expects of this person today — the happy path,
   * and usually one card. `shifts` is every shift the branch runs today, which
   * is what someone COVERING needs: they are not on the roster, so their own
   * schedule is empty and choosing from it would be impossible.
   */
  const [status, shifts, mine, shopRoster] = await Promise.all([
    attendanceStatus(actor),
    listShiftsForToday(actor, session.shopId),
    myScheduleToday(actor, session.shopId),
    resolveDay(actor, session.shopId, actor.businessDate),
  ]);

  return (
    <ClockInFlow
      shopName={session.shop.name}
      shifts={shifts}
      mySlots={mine.slots}
      scheduled={mine.scheduled}
      onLeave={mine.onLeave}
      /**
       * Whether ANYONE is rostered here today. A branch with no timetable yet
       * behaves exactly as it did pre-§4.14.1 — no cover prompt — and the
       * server's gate agrees (`hasRoster` in `clockIn`). The two must match, or
       * the screen demands a reason the API would have accepted without.
       */
      shopHasRoster={shopRoster.length > 0}
      openRecord={status.openRecords[0] ?? null}
      /**
       * Where "Done" goes. Both buttons used to be hardcoded to /dashboard,
       * which is MANAGER-or-OWNER only — so a STAFF member finishing a
       * clock-in was sent straight to a 403 (D-113). `landingPathFor` already
       * knows the answer per role; this reuses it rather than adding a second
       * rule that can drift.
       */
      doneHref={landingPathFor(actor.isOwner)}
    />
  );
}
