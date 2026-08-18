import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { attendanceReport } from "@/server/services/reports";
import { listAttendance } from "@/server/services/attendance";
import { Card, CardContent } from "@/components/ui/card";
import {
  AttendanceRecordCard,
  type AttendanceRecord,
} from "../../attendance/attendance-record-card";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Attendance & Lateness · Marblehouse" };
export const dynamic = "force-dynamic";

const percent = (rate: string) => `${(Number(rate) * 100).toFixed(1)}%`;

/**
 * Attendance & Lateness (§9, §8.9).
 *
 * Manager-safe — nothing here is a cost figure — but a manager sees only their
 * own shop, resolved from their work session. Staff are refused inside the
 * service as well as by the guard (§3.4).
 *
 * Two views behind one URL. Without `userId` it is the ranked lateness table;
 * with one it is that person's individual records for the SAME range, photo
 * and all. The owner asking "who is late" and the owner asking "show me
 * Tuesday" are the same question two clicks apart, and the photo used to be
 * reachable only from `/attendance`, which an owner has no nav link to —
 * clock-in is optional for them (§4.13), so that screen opens empty.
 *
 * The drill-in is deliberately read-only. Excusing a record stays on the
 * history screen: a report is where numbers are read, and an edit control on
 * the surface that reports the number invites correcting the figure rather
 * than the fact.
 */
export default async function AttendanceReportPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    shopId?: string;
    userId?: string;
  }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const { rows, totals } = await attendanceReport(actor, {
    from,
    to,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  // Preserve the current filters across the drill-in, both ways. A drill-in
  // that lost the date range would answer a different question than the row
  // that was clicked.
  const rangeParams = new URLSearchParams({ from, to });
  if (sp.shopId) rangeParams.set("shopId", sp.shopId);

  const selected = sp.userId
    ? rows.find((r) => r.userId === sp.userId)
    : undefined;

  if (sp.userId) {
    // `listAttendance` re-scopes by role in SQL, so a manager hand-editing the
    // URL to another shop's user gets an empty list rather than a leak — the
    // guard is not this page's to make.
    const records = (await listAttendance(actor, {
      userId: sp.userId,
      from,
      to,
      ...(sp.shopId ? { shopId: sp.shopId } : {}),
    }).catch(asPageError)) as AttendanceRecord[];

    return (
      <ReportShell
        title="Attendance & Lateness"
        description={
          selected
            ? `${selected.displayName} · every record in this period`
            : "Every record in this period"
        }
        from={from}
        to={to}
        exportName="attendance"
        shopId={sp.shopId}
        {...filters}
      >
        <Link
          href={`/reports/attendance?${rangeParams.toString()}`}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          All staff
        </Link>

        {selected && (
          <ReportTotals
            items={[
              { label: "Records", value: formatAmount(selected.records) },
              { label: "Late arrivals", value: formatAmount(selected.lateCount) },
              { label: "Late rate", value: percent(selected.lateRate) },
              {
                label: "Total minutes late",
                value: formatAmount(selected.totalLateMinutes),
              },
            ]}
          />
        )}

        {records.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No attendance records for this person in this period.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {records.map((record) => (
              <Card key={record.id}>
                <CardContent className="pt-6">
                  <AttendanceRecordCard record={record} />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* `listAttendance` caps at 50 rows. Scoped to one person this only
            bites on a range longer than about seven weeks, but a silently
            truncated list is exactly the kind of thing that gets trusted. */}
        {records.length === 50 && (
          <p className="text-sm text-muted-foreground">
            Showing the 50 most recent records. Narrow the date range to see
            earlier ones.
          </p>
        )}
      </ReportShell>
    );
  }

  return (
    <ReportShell
      title="Attendance & Lateness"
      description="Based on clock-in, against the shift booked at the time"
      from={from}
      to={to}
      exportName="attendance"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          { label: "Records", value: formatAmount(totals.records) },
          { label: "Late arrivals", value: formatAmount(totals.lateCount) },
          { label: "Late rate", value: percent(totals.lateRate) },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        Lateness is measured from the shift start recorded at the moment of
        clock-in, so editing a shift later never rewrites past lateness. Five
        minutes late is on time; five minutes and one second is late. Tap a name
        to see that person&apos;s clock-in times and photos.
      </p>

      <ReportTable
        rows={rows}
        getKey={(r) => r.userId}
        empty="No attendance records in this period."
        columns={[
          {
            header: "Staff",
            cell: (r) => {
              const params = new URLSearchParams(rangeParams);
              params.set("userId", r.userId);
              return (
                <Link
                  href={`/reports/attendance?${params.toString()}`}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {r.displayName}
                  <ChevronRight className="size-4" />
                </Link>
              );
            },
          },
          { header: "Records", cell: (r) => formatAmount(r.records), numeric: true },
          { header: "Late", cell: (r) => formatAmount(r.lateCount), numeric: true },
          { header: "Late rate", cell: (r) => percent(r.lateRate), numeric: true },
          {
            header: "Avg. minutes late",
            cell: (r) => r.averageLateMinutes,
            numeric: true,
          },
          {
            header: "Total minutes late",
            cell: (r) => formatAmount(r.totalLateMinutes),
            numeric: true,
          },
        ]}
      />
    </ReportShell>
  );
}
