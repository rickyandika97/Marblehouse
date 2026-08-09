/**
 * Business-date boundaries (PRD §15, §4.2, D-18).
 *
 * §15 names these cases explicitly:
 *
 *   "Business-date computation across the global `businessDayStartHour`
 *    boundary, including 03:59, 04:00, 23:59 and 00:01."
 *
 *   "A work session created at 02:00 gets the *previous* calendar date, and a
 *    sale recorded ten minutes later gets the same `businessDate`. These two
 *    must never disagree."
 *
 * These were the backfill the build log's debts table called out as worth
 * doing soonest: every phase stamps `businessDate`, D-18 made the cutoff
 * global, and until now nothing tested the rule underneath every
 * transactional row.
 *
 * Pure-function tests — no database. `businessDateFor` is the single
 * implementation both the work session (`actorBusinessDate` in
 * `server/auth/context.ts`) and every transactional row call, so exercising
 * it here covers both paths. What differs between those two call sites is the
 * TIMEZONE argument, not the hour — the hour is global — and the last block
 * below pins exactly that.
 */
import { describe, expect, it } from "vitest";
import { businessDateFor, formatBusinessDate, localParts } from "../business-date";

const JAKARTA = "Asia/Jakarta"; // UTC+7, no DST — the v1 assumption (§11)
const CUTOFF = 4; // the seeded global businessDayStartHour (D-18)

/**
 * An instant from a Jakarta wall-clock reading.
 *
 * Written as an explicit UTC offset rather than a local-time string so the
 * test does not depend on the machine's own TZ. 09:00 Jakarta is 02:00 UTC.
 */
function jakarta(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 7, minute));
}

/** The business date as a plain "YYYY-MM-DD", which is what reports group by. */
function businessDay(at: Date, timezone = JAKARTA): string {
  return formatBusinessDate(businessDateFor(at, timezone, CUTOFF));
}

describe("the four boundary times §15 names", () => {
  // 5 August 2026 is an ordinary Wednesday — no month or year edge in play,
  // so a failure here is the cutoff logic and nothing else.
  it("03:59 files under the PREVIOUS day", () => {
    expect(businessDay(jakarta(2026, 8, 5, 3, 59))).toBe("2026-08-04");
  });

  it("04:00 starts the NEW day", () => {
    expect(businessDay(jakarta(2026, 8, 5, 4, 0))).toBe("2026-08-05");
  });

  it("23:59 is still the SAME day", () => {
    expect(businessDay(jakarta(2026, 8, 5, 23, 59))).toBe("2026-08-05");
  });

  it("00:01 files under the PREVIOUS day", () => {
    expect(businessDay(jakarta(2026, 8, 6, 0, 1))).toBe("2026-08-05");
  });

  it("moves to the next day at 04:00 exactly, not 03:59:59", () => {
    // The half-open interval matters: an instant may belong to exactly one
    // business day, so the boundary has to be closed on one side only.
    expect(businessDay(jakarta(2026, 8, 5, 3, 59))).toBe("2026-08-04");
    expect(businessDay(new Date(jakarta(2026, 8, 5, 4, 0).getTime() - 1000))).toBe(
      "2026-08-04"
    );
    expect(businessDay(jakarta(2026, 8, 5, 4, 0))).toBe("2026-08-05");
  });
});

describe("the whole 24 hours are covered exactly once", () => {
  it("assigns every hour of a day to one of exactly two business dates", () => {
    // A cheap completeness check: no hour may fall through, and no hour may
    // land on a third date. 00:00–03:59 → the 4th; 04:00–23:59 → the 5th.
    const seen = new Map<string, number>();
    for (let hour = 0; hour < 24; hour++) {
      const day = businessDay(jakarta(2026, 8, 5, hour, 30));
      seen.set(day, (seen.get(day) ?? 0) + 1);
    }

    expect([...seen.keys()].sort()).toEqual(["2026-08-04", "2026-08-05"]);
    expect(seen.get("2026-08-04")).toBe(4); // 00:30, 01:30, 02:30, 03:30
    expect(seen.get("2026-08-05")).toBe(20);
  });
});

describe("calendar edges", () => {
  it("rolls back across a month boundary", () => {
    // 1 Aug 02:00 belongs to 31 July — the month, not just the day, moves.
    expect(businessDay(jakarta(2026, 8, 1, 2, 0))).toBe("2026-07-31");
  });

  it("rolls back across a year boundary", () => {
    expect(businessDay(jakarta(2027, 1, 1, 1, 0))).toBe("2026-12-31");
  });

  it("rolls back into a leap day", () => {
    // 2028 is a leap year: 1 Mar 02:00 must land on 29 Feb, not 28 Feb.
    expect(businessDay(jakarta(2028, 3, 1, 2, 0))).toBe("2028-02-29");
  });
});

describe("the returned Date is a clean UTC midnight", () => {
  it("has no time component, so it round-trips through a Postgres DATE", () => {
    // businessDate is a DATE column. A value carrying 17:00 UTC would compare
    // and group unpredictably against dates written by another code path.
    const d = businessDateFor(jakarta(2026, 8, 5, 23, 30), JAKARTA, CUTOFF);

    expect(d.getUTCHours()).toBe(0);
    expect(d.getUTCMinutes()).toBe(0);
    expect(d.getUTCSeconds()).toBe(0);
    expect(d.getUTCMilliseconds()).toBe(0);
    expect(d.toISOString()).toBe("2026-08-05T00:00:00.000Z");
  });
});

describe("§15: a work session and a sale ten minutes later must agree", () => {
  /**
   * The scenario as §15 words it. `actorBusinessDate` and `createSale` are
   * separate call sites — the bug this guards against is the two drifting so
   * a sale files under a different day than the shift that recorded it.
   */
  it("a 02:00 work session takes the PREVIOUS calendar date", () => {
    expect(businessDay(jakarta(2026, 8, 5, 2, 0))).toBe("2026-08-04");
  });

  it("a sale at 02:10 gets the same businessDate as the 02:00 session", () => {
    const session = businessDateFor(jakarta(2026, 8, 5, 2, 0), JAKARTA, CUTOFF);
    const sale = businessDateFor(jakarta(2026, 8, 5, 2, 10), JAKARTA, CUTOFF);

    expect(sale.getTime()).toBe(session.getTime());
    expect(formatBusinessDate(sale)).toBe("2026-08-04");
  });

  it("holds across the cutoff too: 03:55 and 04:05 deliberately DISAGREE", () => {
    // The pair above would also pass if the function returned a constant, so
    // pin the other side: two instants either side of the cutoff must differ.
    // A staff member clocking in at 03:55 and selling at 04:05 genuinely does
    // straddle two business days — that is the rule working, not a bug.
    const before = businessDateFor(jakarta(2026, 8, 5, 3, 55), JAKARTA, CUTOFF);
    const after = businessDateFor(jakarta(2026, 8, 5, 4, 5), JAKARTA, CUTOFF);

    expect(before.getTime()).not.toBe(after.getTime());
    expect(formatBusinessDate(before)).toBe("2026-08-04");
    expect(formatBusinessDate(after)).toBe("2026-08-05");
  });

  it("agrees across a whole overnight shift, 22:00 through 03:00", () => {
    // A night shift spans midnight. Every row it writes must file under the
    // day the shift STARTED, which is what makes a shift's takings one figure.
    const expected = "2026-08-05";
    for (const at of [
      jakarta(2026, 8, 5, 22, 0),
      jakarta(2026, 8, 5, 23, 59),
      jakarta(2026, 8, 6, 0, 1),
      jakarta(2026, 8, 6, 2, 0),
      jakarta(2026, 8, 6, 3, 59),
    ]) {
      expect(businessDay(at)).toBe(expected);
    }
  });
});

describe("the hour is GLOBAL, so two branches agree (D-18)", () => {
  /**
   * D-18's whole point: branches share one cutoff, so a combined daily report
   * sums one definition of "a day". Two shops in the same timezone must
   * therefore never disagree about an instant, whatever their opening hours.
   */
  it("two shops in one timezone file the same instant under the same day", () => {
    const at = jakarta(2026, 8, 5, 2, 30);
    const mall = businessDateFor(at, JAKARTA, CUTOFF);
    const standalone = businessDateFor(at, JAKARTA, CUTOFF);

    expect(mall.getTime()).toBe(standalone.getTime());
  });

  it("a DIFFERENT hour would move the date — which is why it must not be per-shop", () => {
    // This is the bug D-18 removed the possibility of, asserted directly: the
    // same instant under a 6am cutoff files a day earlier than under 4am. If
    // a per-shop hour is ever reintroduced, this is what it costs.
    const at = jakarta(2026, 8, 5, 5, 0);

    expect(formatBusinessDate(businessDateFor(at, JAKARTA, 4))).toBe("2026-08-05");
    expect(formatBusinessDate(businessDateFor(at, JAKARTA, 6))).toBe("2026-08-04");
  });

  it("midnight cutoff 0 makes the business date the calendar date", () => {
    // The degenerate case, worth pinning: with hour 0 nothing shifts back.
    expect(formatBusinessDate(businessDateFor(jakarta(2026, 8, 5, 0, 1), JAKARTA, 0))).toBe(
      "2026-08-05"
    );
    expect(formatBusinessDate(businessDateFor(jakarta(2026, 8, 5, 23, 59), JAKARTA, 0))).toBe(
      "2026-08-05"
    );
  });
});

describe("timezone handling", () => {
  it("reads the wall clock of the given zone, not the server's", () => {
    // 20:00 UTC on 4 Aug is 03:00 Jakarta on 5 Aug — before the cutoff, so it
    // files under the 4th. Computed in UTC it would file under the 4th too,
    // for the wrong reason, so check the parts rather than only the answer.
    const at = new Date("2026-08-04T20:00:00.000Z");

    expect(localParts(at, JAKARTA)).toMatchObject({
      year: 2026,
      month: 8,
      day: 5,
      hour: 3,
    });
    expect(businessDay(at)).toBe("2026-08-04");
  });

  it("renders hour 0 as 0, never 24", () => {
    // localParts guards against runtimes that format midnight as hour 24. A
    // 24 here would compare >= 4 and file midnight under the wrong day.
    const midnight = jakarta(2026, 8, 5, 0, 0);

    expect(localParts(midnight, JAKARTA).hour).toBe(0);
    expect(businessDay(midnight)).toBe("2026-08-04");
  });
});
