"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle } from "lucide-react";

/**
 * The red clock-in banner (§4.13).
 *
 * "Fixed to the top of the viewport, high-contrast red, present on every
 * screen, and **not dismissible**."
 *
 * There is deliberately no close button and no `dismissed` state. The banner
 * disappears for exactly one reason: the user clocked in. That is the whole
 * design — a banner staff can dismiss is a banner staff will dismiss, and the
 * attendance record it exists to produce never gets made.
 *
 * **It does not block work** (owner decision, D-45). §4.13's flow says the user
 * "can work normally" with the banner showing, so a staff member facing a queue
 * of customers records sales first and clocks in a minute later. The record
 * still captures their real arrival time, so lateness reporting is unaffected.
 *
 * Status comes from the server (`/api/attendance/status`), never from local
 * state: whether someone has clocked in is a fact about the database, and a
 * client that decided for itself would let a page refresh hide the banner.
 *
 * **§4.14.1 narrowed WHEN it appears.** It used to show for every non-owner
 * every day, including a staff member's day off — which taught everyone to
 * ignore it, the one thing a non-dismissible banner cannot survive. Now the
 * server decides via `prompt`, which is true only when the roster actually
 * expects this person at this branch today.
 *
 * Someone unscheduled can still clock in (covering a colleague); they reach it
 * from the Attendance screen and give a reason. The banner staying quiet is not
 * a permission — see `schedule.ts`.
 */
export function AttendanceBanner() {
  const pathname = usePathname();
  const [state, setState] = useState<{
    prompt: boolean;
    slots: { shiftName: string; startTime: string; wouldBeLate: boolean }[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/attendance/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setState({ prompt: data.prompt ?? false, slots: data.slots ?? [] });
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
    // Re-checked on navigation so the banner clears as soon as the clock-in
    // page redirects back, without a full reload.
  }, [pathname]);

  // Nothing until the server has answered — a banner that flashes on every
  // page load and then vanishes is worse than one that appears a moment late.
  if (!state) return null;

  // The server has already weighed role, roster and whether they clocked in.
  // Deliberately ONE flag rather than three conditions re-derived here — the
  // rule lives in `attendanceStatus`, and a second copy would drift.
  if (!state.prompt) return null;

  // Already on the clock-in screen: the banner would be pointing at itself.
  if (pathname.startsWith("/attendance/clock-in")) return null;

  return (
    <Link
      href="/attendance/clock-in"
      className="sticky top-14 z-30 flex items-center gap-3 bg-red-600 px-4 py-3 text-white hover:bg-red-700"
    >
      <AlertTriangle className="size-5 shrink-0" aria-hidden />
      <span className="text-sm font-semibold">
        {shiftLabel(state.slots)} Tap here to clock in.
      </span>
    </Link>
  );
}

/**
 * Name the shift they are expected on, when there is exactly one.
 *
 * "Your 08:00 Morning shift" is a materially better prompt than "you have not
 * clocked in": it tells someone working two branches WHICH one this is about.
 * With a split shift the specific time would be ambiguous, so it falls back.
 */
function shiftLabel(
  slots: { shiftName: string; startTime: string; wouldBeLate: boolean }[]
): string {
  const first = slots[0];
  if (slots.length !== 1 || !first) {
    return "You have not clocked in today.";
  }
  return first.wouldBeLate
    ? `Your ${first.shiftName} shift started at ${first.startTime}.`
    : `You are on the ${first.shiftName} shift (${first.startTime}).`;
}
