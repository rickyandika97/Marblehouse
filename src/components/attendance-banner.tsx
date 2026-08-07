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
 */
export function AttendanceBanner() {
  const pathname = usePathname();
  const [state, setState] = useState<{
    required: boolean;
    clockedIn: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch("/api/attendance/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data) {
          setState({ required: data.required, clockedIn: data.clockedIn });
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

  // OWNER is optional (§4.13), and a satisfied requirement shows nothing.
  if (!state.required || state.clockedIn) return null;

  // Already on the clock-in screen: the banner would be pointing at itself.
  if (pathname.startsWith("/attendance/clock-in")) return null;

  return (
    <Link
      href="/attendance/clock-in"
      className="sticky top-14 z-30 flex items-center gap-3 bg-red-600 px-4 py-3 text-white hover:bg-red-700"
    >
      <AlertTriangle className="size-5 shrink-0" aria-hidden />
      <span className="text-sm font-semibold">
        You have not clocked in today. Tap here to clock in.
      </span>
    </Link>
  );
}
