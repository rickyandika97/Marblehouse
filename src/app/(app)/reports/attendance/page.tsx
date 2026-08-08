import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { attendanceReport } from "@/server/services/reports";
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
 */
export default async function AttendanceReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
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
        minutes late is on time; five minutes and one second is late.
      </p>

      <ReportTable
        rows={rows}
        getKey={(r) => r.userId}
        empty="No attendance records in this period."
        columns={[
          { header: "Staff", cell: (r) => r.displayName },
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
