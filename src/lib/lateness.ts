/**
 * Lateness (PRD §4.13, §4.14).
 *
 *   isLate = clockInAt > shiftStart + gracePeriod
 *
 * Pure arithmetic on wall-clock time, deliberately kept out of the service so
 * §15's boundary cases can be tested without a database.
 *
 * Two things here are easy to get subtly wrong, and §15 names both:
 *
 * 1. **The grace boundary is inclusive.** "5:00 late is not late; 5:01 is."
 *    So the comparison is `> grace`, never `>=`. Getting this backwards makes
 *    every staff member arriving exactly on the grace limit late, which is the
 *    kind of error that shows up as an argument about wages, not a bug report.
 *
 * 2. **A shift may cross midnight** (`endTime < startTime`, §4.14). A 22:00
 *    shift clocked into at 00:05 is five minutes into the NEXT calendar day but
 *    two hours EARLY for its shift, not 23 hours and 55 minutes late.
 *
 * **Why the caller passes `clockInDayOffset` rather than letting this function
 * infer the crossing.** An earlier version guessed: "a delta of more than 12
 * hours on a midnight-crossing shift must really be an early arrival." That
 * heuristic was untestable *and* unreachable — a raw 00:05 against a 22:00
 * start is already −1315, so the branch never ran, and deleting it entirely
 * left every test green. A mutation caught that (BUILD-LOG D-45).
 *
 * The caller knows the real calendar dates, so it states the offset as a fact
 * instead: 0 = clocked in on the shift's own start date, 1 = clocked in after
 * midnight, on the following calendar day. No guessing, and both branches are
 * reachable from a test.
 */

/** Minutes from local midnight, from a `HH:MM` wall-clock time. */
export function minutesFromMidnight(hour: number, minute: number): number {
  return hour * 60 + minute;
}

export interface LatenessInput {
  /** Wall-clock minutes-from-midnight the shift starts. */
  shiftStartMin: number;
  /** Wall-clock minutes-from-midnight the user clocked in. */
  clockInMin: number;
  /**
   * 0 when the clock-in happened on the shift's start date, 1 when it happened
   * after midnight on the next calendar day. Only ever 1 for a shift that
   * crosses midnight (§4.14).
   */
  clockInDayOffset: 0 | 1;
  /** Per-shop grace, §4.13 default 5. */
  graceMin: number;
}

export interface LatenessResult {
  isLate: boolean;
  /** Whole minutes past shift start (NOT past grace). 0 when not late. */
  lateMinutes: number;
}

/**
 * Compute lateness for one clock-in.
 *
 * `lateMinutes` measures from **shift start**, not from the end of grace: a
 * staff member who arrives 7 minutes after a 22:00 start with 5 minutes grace
 * is late by 7, not by 2. Grace decides *whether* they are late; the stored
 * figure is how late they actually were, which is what a lateness report means.
 */
export function computeLateness({
  shiftStartMin,
  clockInMin,
  clockInDayOffset,
  graceMin,
}: LatenessInput): LatenessResult {
  // A clock-in after midnight is that many minutes further into the shift.
  const delta = clockInMin + clockInDayOffset * 24 * 60 - shiftStartMin;

  // Inclusive grace: exactly `graceMin` late is ON TIME (§15).
  const isLate = delta > graceMin;

  return {
    isLate,
    lateMinutes: isLate ? Math.floor(delta) : 0,
  };
}

/**
 * Which calendar day a clock-in falls on relative to its shift's start date.
 *
 * Only a midnight-crossing shift can produce 1. For a normal shift an
 * early-hours clock-in is simply a very early or very late arrival on the same
 * day, and the raw difference already says which.
 */
export function clockInDayOffsetFor(
  shiftStartMin: number,
  shiftEndMin: number,
  clockInMin: number,
): 0 | 1 {
  const crossesMidnight = shiftEndMin < shiftStartMin;
  if (!crossesMidnight) return 0;

  // On a crossing shift the working window is [start .. 24:00) ∪ [00:00 .. end].
  // A clock-in at or before `end` is in the after-midnight half.
  return clockInMin <= shiftEndMin ? 1 : 0;
}
