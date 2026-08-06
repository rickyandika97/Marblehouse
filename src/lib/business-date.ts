/**
 * Business-day helpers (PRD §4.2).
 *
 * The reporting day starts at `dayStartHour` (04:00), not midnight, so a
 * session that runs past midnight belongs to the day it started. ALL daily
 * reporting groups by businessDate, never by raw timestamp.
 *
 * The hour is GLOBAL, not per-shop — read it from
 * `getBusinessDayStartHour()` in `server/services/settings.ts` rather than
 * passing a shop's value. See D-18.
 *
 * The server computes this. The client never sends a businessDate.
 */

/**
 * Business date for an instant, as a UTC-midnight Date suitable for a
 * Postgres DATE column.
 *
 * @param at         the instant (defaults to now)
 * @param timezone   IANA zone, e.g. "Asia/Jakarta"
 * @param dayStartHour  0-23; times before this belong to the previous day.
 *                      Pass `await getBusinessDayStartHour()`. The default
 *                      here only matches the seeded value so that a missed
 *                      argument cannot silently file records against a
 *                      different day than the rest of the system.
 */
export function businessDateFor(
  at: Date = new Date(),
  timezone = "Asia/Jakarta",
  dayStartHour = 4
): Date {
  const { year, month, day, hour } = localParts(at, timezone);

  // Before the cutoff → still yesterday's business day.
  const shifted = Date.UTC(year, month - 1, day) - (hour < dayStartHour ? 86_400_000 : 0);
  return new Date(shifted);
}

/** Local wall-clock parts of an instant in a given IANA timezone. */
export function localParts(at: Date, timezone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(at)) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }

  return {
    year: parts.year!,
    month: parts.month!,
    // Intl renders midnight as hour 24 in some runtimes.
    day: parts.day!,
    hour: parts.hour! % 24,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** "2026-08-04" — for display and CSV export. */
export function formatBusinessDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
