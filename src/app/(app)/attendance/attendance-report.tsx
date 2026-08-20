import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { attendanceReport } from "@/server/services/reports";
import {
  listAttendance,
  listAttendanceAttention,
} from "@/server/services/attendance";
import { Card, CardContent } from "@/components/ui/card";
import { AttendanceRecordCard, type AttendanceRecord } from "./attendance-record-card";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  rangeFrom,
  filterPropsFor,
} from "../reports/report-shell";

export type AttendanceReportSearchParams = {
  from?: string;
  to?: string;
  shopId?: string;
  userId?: string;
};

const percent = (rate: string) => `${(Number(rate) * 100).toFixed(1)}%`;

type NotClockedInEmployee = {
  userId: string;
  displayName: string;
  shop: { id: string; name: string; code: string };
};

/**
 * The manager/owner reporting view of Attendance. It lives under the same
 * route as attendance history, rather than making a person choose which of
 * two near-identical attendance destinations they meant.
 */
export async function AttendanceReport({
  searchParams: sp,
}: {
  searchParams: AttendanceReportSearchParams;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const { rows, totals } = await attendanceReport(actor, {
    from,
    to,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  // The dashboard asks a live, today-only question. Keep its named answers
  // visible on the unified report rather than making alerts point at a second
  // attendance screen. These lists deliberately use the same service that
  // supplies the dashboard counts, so a name cannot disagree with its alert.
  const [notClockedIn, lateToday] = await Promise.all([
    listAttendanceAttention(actor, {
      issue: "not-clocked-in",
      ...(sp.shopId ? { shopId: sp.shopId } : {}),
    }),
    listAttendanceAttention(actor, {
      issue: "late",
      ...(sp.shopId ? { shopId: sp.shopId } : {}),
    }),
  ]);

  // `view=report` is part of the route contract: retain it while drilling
  // into a staff member, so every link stays inside /attendance.
  const rangeParams = new URLSearchParams({ view: "report", from, to });
  if (sp.shopId) rangeParams.set("shopId", sp.shopId);

  const selected = sp.userId
    ? rows.find((row) => row.userId === sp.userId)
    : undefined;

  if (sp.userId) {
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
          href={`/attendance?${rangeParams.toString()}`}
          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          All staff
        </Link>

        {selected && (
          <ReportTotals
            contentClassName="pt-0"
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

        {records.length === 50 && (
          <p className="text-sm text-muted-foreground">
            Showing the 50 most recent records. Narrow the date range to see earlier ones.
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
      <Link
        href="/attendance"
        className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        Attendance history
      </Link>

      <TodayAttention
        notClockedIn={notClockedIn as NotClockedInEmployee[]}
        lateToday={lateToday as AttendanceRecord[]}
      />

      <ReportTotals
        contentClassName="pt-0"
        items={[
          { label: "Records", value: formatAmount(totals.records) },
          { label: "Late arrivals", value: formatAmount(totals.lateCount) },
          { label: "Late rate", value: percent(totals.lateRate) },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        Lateness is measured from the shift start recorded at the moment of clock-in, so
        editing a shift later never rewrites past lateness. Five minutes late is on time;
        five minutes and one second is late. Tap a name to see that person&apos;s clock-in
        times and photos.
      </p>

      <ReportTable
        rows={rows}
        getKey={(row) => row.userId}
        empty="No attendance records in this period."
        columns={[
          {
            header: "Staff",
            cell: (row) => {
              const params = new URLSearchParams(rangeParams);
              params.set("userId", row.userId);
              return (
                <Link
                  href={`/attendance?${params.toString()}`}
                  className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
                >
                  {row.displayName}
                  <ChevronRight className="size-4" />
                </Link>
              );
            },
          },
          { header: "Records", cell: (row) => formatAmount(row.records), numeric: true },
          { header: "Late", cell: (row) => formatAmount(row.lateCount), numeric: true },
          { header: "Late rate", cell: (row) => percent(row.lateRate), numeric: true },
          {
            header: "Avg. minutes late",
            cell: (row) => row.averageLateMinutes,
            numeric: true,
          },
          {
            header: "Total minutes late",
            cell: (row) => formatAmount(row.totalLateMinutes),
            numeric: true,
          },
        ]}
      />
    </ReportShell>
  );
}

/** The named, live counterparts of the dashboard's attendance alert counts. */
function TodayAttention({
  notClockedIn,
  lateToday,
}: {
  notClockedIn: NotClockedInEmployee[];
  lateToday: AttendanceRecord[];
}) {
  if (notClockedIn.length === 0 && lateToday.length === 0) return null;

  return (
    <section className="grid gap-3 md:grid-cols-2" aria-label="Today's attendance alerts">
      <Card>
        <CardContent className="pt-0">
          <h2 className="font-semibold">Not clocked in today</h2>
          {notClockedIn.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">Everyone has clocked in.</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm">
              {notClockedIn.map((employee) => (
                <li key={`${employee.shop.id}:${employee.userId}`}>
                  {employee.displayName}
                  <span className="text-muted-foreground"> · {employee.shop.name}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-0">
          <h2 className="font-semibold">Arrived late today</h2>
          {lateToday.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No late arrivals.</p>
          ) : (
            <ul className="mt-2 space-y-1.5 text-sm">
              {lateToday.map((record) => (
                <li key={record.id}>
                  {record.user.displayName}
                  <span className="text-muted-foreground">
                    {` · ${record.lateMinutes} min late · ${record.shop.name}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
