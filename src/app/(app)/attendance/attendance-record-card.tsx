import { MapPinOff } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One attendance record, with its photo (§4.13, §8.9).
 *
 * Shared by the Attendance history screen and the Attendance & Lateness report
 * drill-in, so the two cannot drift on what a record looks like — in
 * particular on the three photo states, which are easy to collapse into two by
 * accident. A purged photo and a record that never had one are different
 * facts, and the owner reading a record months later needs to be told which.
 */
export interface AttendanceRecord {
  id: string;
  businessDate: string;
  clockInAt: string;
  clockOutAt: string | null;
  isLate: boolean;
  lateMinutes: number;
  status: string;
  locationDenied: boolean;
  photoUrl: string | null;
  photoPurged: boolean;
  note: string | null;
  scheduleSource: "SCHEDULED" | "COVER" | "MANUAL";
  coverReason: string | null;
  user: { id: string; displayName: string };
  shop: { id: string; name: string; code: string };
  shift: { id: string; name: string } | null;
}

export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "09:02 → 17:16", or "09:02 → still in" for a shift with no clock-out.
 *
 * The open case is deliberately not left as a bare clock-in time. A record with
 * no clock-out is genuinely different from a completed one — it is either
 * someone still working or someone who forgot — and collapsing the two is what
 * made the team screen look unfinished.
 */
export function clockRange(clockInAt: string, clockOutAt: string | null): string {
  return clockOutAt
    ? `${hhmm(clockInAt)} → ${hhmm(clockOutAt)}`
    : `${hhmm(clockInAt)} → still in`;
}

/** The coloured status pill used in both the list and the detail. */
export function StatusPill({ record }: { record: AttendanceRecord }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
        record.status === "EXCUSED" && "bg-muted text-muted-foreground",
        record.status === "LATE" && "bg-red-100 text-red-900",
        record.status === "PRESENT" && "bg-emerald-100 text-emerald-900"
      )}
    >
      {record.status === "LATE" ? `${record.lateMinutes} min late` : record.status}
    </span>
  );
}

/** The photo, or the reason there isn't one. Never renders nothing. */
export function AttendancePhoto({ record }: { record: AttendanceRecord }) {
  if (record.photoPurged) {
    return (
      <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
        The photo for this day passed its 61-day retention and was deleted. The
        attendance record itself is kept.
      </p>
    );
  }

  if (!record.photoUrl) {
    // Previously this branch rendered null, which looked identical to a
    // missing feature rather than a missing photo.
    return (
      <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
        No photo was captured with this record.
      </p>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={record.photoUrl}
      alt={`Clock-in photo for ${record.businessDate}`}
      className="w-full rounded-lg border"
    />
  );
}

/**
 * The full record: who, when, where, and the photo.
 *
 * `actions` is a slot rather than a prop-driven button so the report drill-in
 * can stay read-only while the history screen keeps the owner's Excuse control
 * — a report is a place to read numbers, not to edit them.
 */
export function AttendanceRecordCard({
  record,
  actions,
}: {
  record: AttendanceRecord;
  actions?: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">{record.user.displayName}</p>
          <p className="text-sm text-muted-foreground">
            {record.businessDate} · {record.shop.name}
          </p>
          <p className="text-sm text-muted-foreground">
            {clockRange(record.clockInAt, record.clockOutAt)}
            {record.shift ? ` · ${record.shift.name}` : ""}
          </p>
          {record.scheduleSource === "COVER" && (
            <p className="text-sm font-medium text-amber-700">
              Outside scheduled shift{record.coverReason ? ` · ${record.coverReason}` : ""}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {record.locationDenied && (
            <MapPinOff
              className="size-4 text-amber-600"
              aria-label="Location unavailable"
            />
          )}
          <StatusPill record={record} />
        </div>
      </div>

      <AttendancePhoto record={record} />

      {record.note && <p className="text-sm">{record.note}</p>}

      {actions}
    </div>
  );
}
