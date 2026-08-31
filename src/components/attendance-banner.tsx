"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight, Clock } from "lucide-react";

/**
 * The attendance prompt banner (§4.13).
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
 * state: whether someone has clocked in or their shift has ended is a fact
 * about the database and branch timezone, not the browser clock.
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
    clockOutPrompt: {
      attendanceId: string;
      shopName: string;
      shiftName: string;
      endTime: string;
    } | null;
    shopName: string | null;
    slots: { shiftName: string; startTime: string; wouldBeLate: boolean }[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = () => {
      fetch("/api/attendance/status")
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && data) {
            setState({
              prompt: data.prompt ?? false,
              clockOutPrompt: data.clockOutPrompt ?? null,
              shopName: data.shopName ?? null,
              slots: data.slots ?? [],
            });
          }
        })
        .catch(() => undefined);
    };

    load();
    window.addEventListener("work-session-changed", load);
    window.addEventListener("attendance-changed", load);

    // The shift can end while the person is working on the same screen. Poll
    // once per minute so the reminder appears without requiring navigation.
    const interval = window.setInterval(load, 60_000);

    return () => {
      cancelled = true;
      window.removeEventListener("work-session-changed", load);
      window.removeEventListener("attendance-changed", load);
      window.clearInterval(interval);
    };
    // Re-checked on navigation so the banner clears as soon as the clock-in
    // page redirects back, without a full reload.
  }, [pathname]);

  // Nothing until the server has answered — a banner that flashes on every
  // page load and then vanishes is worse than one that appears a moment late.
  if (!state) return null;

  // An unclosed ended shift is more urgent than a later clock-in, and keeping
  // the priority here gives the shell one banner instead of overlapping bars.
  //
  // The pill is deliberately NOT a submit button (D-172). An overdue record
  // requires a reason and a confirmed finish time, which a one-tap banner
  // cannot collect — POSTing "now" on their behalf would invent a shift
  // length. So it deep-links to the card, which opens its dialog on arrival.
  if (state.clockOutPrompt) {
    const reminder = state.clockOutPrompt;
    return (
      <Link
        href={`/attendance#clock-out=${reminder.attendanceId}`}
        className="sticky top-14 z-30 border-b-4 border-amber-800 bg-amber-500 px-4 py-4 text-amber-950 shadow-sm hover:bg-amber-400"
      >
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <Clock className="mt-1 size-6 shrink-0" aria-hidden />
            <div>
              <p className="text-sm font-bold uppercase tracking-wide">Your shift has ended</p>
              <p className="text-3xl font-black leading-tight sm:text-4xl">
                {reminder.shopName}
              </p>
              <p className="mt-1 text-sm font-medium">
                {reminder.shiftName} ended at {reminder.endTime}. Please clock out.
              </p>
            </div>
          </div>
          <span className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-black/10 px-5 text-base font-bold ring-1 ring-black/20">
            Clock out <ArrowRight className="size-5" aria-hidden />
          </span>
        </div>
      </Link>
    );
  }

  // The server has already weighed role, roster and whether they clocked in.
  // Deliberately ONE flag rather than three conditions re-derived here — the
  // rule lives in `attendanceStatus`, and a second copy would drift.
  if (!state.prompt) return null;

  // Already on the clock-in screen: the banner would be pointing at itself.
  if (pathname.startsWith("/attendance/clock-in")) return null;

  return (
    <Link
      href="/attendance/clock-in"
      className="sticky top-14 z-30 border-b-4 border-red-800 bg-red-600 px-4 py-4 text-white shadow-sm hover:bg-red-700"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Clock className="mt-1 size-6 shrink-0" aria-hidden />
          <div>
            <p className="text-sm font-bold uppercase tracking-wide">Your shift is at</p>
            <p className="text-3xl font-black leading-tight sm:text-4xl">
              {state.shopName ?? "Your current shop"}
            </p>
            <p className="mt-1 text-sm font-medium">{shiftLabel(state.slots)}</p>
          </div>
        </div>
        <span className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-white/15 px-5 text-base font-bold ring-1 ring-white/30">
          Clock in <ArrowRight className="size-5" aria-hidden />
        </span>
      </div>
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
    return "Tap to record your arrival.";
  }
  return first.wouldBeLate
    ? `${first.shiftName} · started at ${first.startTime}`
    : `${first.shiftName} · starts ${first.startTime}`;
}
