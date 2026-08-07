import { redirect } from "next/navigation";
import { requireActorPage } from "@/server/auth/page-guard";
import { resolveWorkSession } from "@/server/services/work-session";
import {
  attendanceStatus,
  listShiftsForToday,
} from "@/server/services/attendance";
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

  const [status, shifts] = await Promise.all([
    attendanceStatus(actor),
    listShiftsForToday(actor, session.shopId),
  ]);

  return (
    <ClockInFlow
      shopName={session.shop.name}
      shifts={shifts}
      alreadyClockedIn={status.clockedIn}
      record={status.record}
    />
  );
}
