/**
 * Lateness boundaries (PRD §15, §4.13, §4.14).
 *
 * §15 names two cases explicitly and both are load-bearing:
 *
 *   "Lateness calculation, including a shift that crosses midnight and a
 *    grace-period boundary at exactly 5 minutes (5:00 late is not late;
 *    5:01 is)."
 *
 * These are pure-function tests — no database — so they are cheap enough to
 * cover every side of both boundaries rather than one happy case each.
 */
import { describe, expect, it } from "vitest";
import {
  clockInDayOffsetFor,
  computeLateness,
  minutesFromMidnight,
} from "../lateness";

/** A 09:00–17:00 day shift with the §4.13 default 5-minute grace. */
const DAY_START = minutesFromMidnight(9, 0);
const DAY_END = minutesFromMidnight(17, 0);
const DAY = {
  shiftStartMin: DAY_START,
  clockInDayOffset: 0 as const,
  graceMin: 5,
};

/** A 22:00–06:00 night shift — endTime < startTime, so it crosses midnight. */
const NIGHT_START = minutesFromMidnight(22, 0);
const NIGHT_END = minutesFromMidnight(6, 0);

/** Build a night-shift input the way the service does: derive the offset. */
function night(hour: number, minute: number) {
  const clockInMin = minutesFromMidnight(hour, minute);
  return {
    shiftStartMin: NIGHT_START,
    clockInMin,
    clockInDayOffset: clockInDayOffsetFor(NIGHT_START, NIGHT_END, clockInMin),
    graceMin: 5,
  };
}

describe("grace boundary (§15: 5:00 is not late, 5:01 is)", () => {
  it("is not late when exactly on time", () => {
    const r = computeLateness({
      ...DAY,
      clockInMin: minutesFromMidnight(9, 0),
    });
    expect(r.isLate).toBe(false);
    expect(r.lateMinutes).toBe(0);
  });

  it("is not late when early", () => {
    const r = computeLateness({
      ...DAY,
      clockInMin: minutesFromMidnight(8, 45),
    });
    expect(r.isLate).toBe(false);
    expect(r.lateMinutes).toBe(0);
  });

  it("is NOT late at exactly the grace limit — 5 minutes", () => {
    const r = computeLateness({
      ...DAY,
      clockInMin: minutesFromMidnight(9, 5),
    });
    expect(r.isLate).toBe(false);
    expect(r.lateMinutes).toBe(0);
  });

  it("IS late one minute past the grace limit — 6 minutes", () => {
    const r = computeLateness({
      ...DAY,
      clockInMin: minutesFromMidnight(9, 6),
    });
    expect(r.isLate).toBe(true);
    // Measured from shift start, not from the end of grace.
    expect(r.lateMinutes).toBe(6);
  });

  it("respects a per-shop grace other than the default", () => {
    const strict = { ...DAY, graceMin: 0 };
    expect(
      computeLateness({ ...strict, clockInMin: minutesFromMidnight(9, 0) })
        .isLate,
    ).toBe(false);
    expect(
      computeLateness({ ...strict, clockInMin: minutesFromMidnight(9, 1) })
        .isLate,
    ).toBe(true);

    const lenient = { ...DAY, graceMin: 15 };
    expect(
      computeLateness({ ...lenient, clockInMin: minutesFromMidnight(9, 15) })
        .isLate,
    ).toBe(false);
    expect(
      computeLateness({ ...lenient, clockInMin: minutesFromMidnight(9, 16) })
        .isLate,
    ).toBe(true);
  });
});

describe("a shift that crosses midnight (§4.14)", () => {
  it("is not late when clocking in before midnight, on time", () => {
    expect(computeLateness(night(22, 0)).isLate).toBe(false);
  });

  it("is not late at exactly the grace limit before midnight", () => {
    expect(computeLateness(night(22, 5)).isLate).toBe(false);
  });

  it("IS late just past grace before midnight", () => {
    const r = computeLateness(night(22, 6));
    expect(r.isLate).toBe(true);
    expect(r.lateMinutes).toBe(6);
  });

  it("does not let a midnight crossing hide genuine lateness", () => {
    // 23:30 for a 22:00 shift is an hour and a half late, and must stay late.
    const r = computeLateness(night(23, 30));
    expect(r.isLate).toBe(true);
    expect(r.lateMinutes).toBe(90);
  });

  it("IS late when arriving after midnight for a night shift", () => {
    // 00:05 is 2h05m INTO a 22:00 shift — genuinely late, by 125 minutes.
    // The offset is what makes this correct; without it the raw difference
    // (-1315) would read as "arrived 22 hours early" and never be late.
    const r = computeLateness(night(0, 5));
    expect(r.isLate).toBe(true);
    expect(r.lateMinutes).toBe(125);
  });

  it("a day shift is unaffected by the midnight logic", () => {
    // 08:00 for a 09:00 day shift is an hour early, never 23 hours late.
    const r = computeLateness({
      ...DAY,
      clockInMin: minutesFromMidnight(8, 0),
    });
    expect(r.isLate).toBe(false);
    expect(r.lateMinutes).toBe(0);
  });

  it("derives the day offset from the shift window", () => {
    // Before midnight, still the shift's own date.
    expect(
      clockInDayOffsetFor(NIGHT_START, NIGHT_END, minutesFromMidnight(22, 30)),
    ).toBe(0);
    // After midnight but inside the window — the next calendar day.
    expect(
      clockInDayOffsetFor(NIGHT_START, NIGHT_END, minutesFromMidnight(0, 5)),
    ).toBe(1);
    expect(
      clockInDayOffsetFor(NIGHT_START, NIGHT_END, minutesFromMidnight(6, 0)),
    ).toBe(1);
    // A non-crossing shift is never offset.
    expect(
      clockInDayOffsetFor(DAY_START, DAY_END, minutesFromMidnight(0, 5)),
    ).toBe(0);
  });
});
