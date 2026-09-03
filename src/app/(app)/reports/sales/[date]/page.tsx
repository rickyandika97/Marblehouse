import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { salesDetail } from "@/server/services/reports";
import { Button } from "@/components/ui/button";
import {
  ReportShell,
  ReportTotals,
  formatAmount,
  formatMoney,
  filterPropsFor,
  isIsoDate,
} from "../../report-shell";
import { SalesDetailTable } from "../../sales-detail-table";

export const metadata = { title: "Day's sales · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Daily Sales Summary → one business day's transactions (§9 drill-down).
 *
 * The day axis of the same drill-down as D-176/D-178: `salesDetail` with the
 * range collapsed to a single date. No service change was needed —
 * `resolveScope` already accepts `from === to`.
 *
 * **`businessDate`, not a wall-clock day.** The date in the URL is the same
 * `businessDate` the row was filed under, so a sale recorded at 01:00 appears
 * on the previous day's page — which is the whole point of §4.2's 04:00 cutoff
 * and the only reading under which this page reconciles with the row that
 * linked here (D-18). The times in the list are the real clock times, which is
 * why a 01:00 row on a page dated yesterday is correct, not a bug.
 *
 * **The shop picker stays; the DATE controls do not** (`hideDateControls`,
 * D-180). Narrowing a mixed-branch day to one shop is a real question an owner
 * asks — the whole page is otherwise PIK and MKG rows interleaved. A range
 * picker is a different matter: this page IS a date selection, so a range
 * control could be set to contradict the date in the path, leaving no way to
 * tell which one produced the figures. Day paging is the previous/next
 * buttons instead.
 */
export default async function DaySalesDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ date: string }>;
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { date } = await params;
  const sp = await searchParams;

  // A path segment, so it can be anything. `rangeFrom`'s forgiving fallback is
  // wrong here: silently showing a different day than the URL names would be
  // worse than a 404.
  if (!isIsoDate(date)) notFound();

  const filters = await filterPropsFor(actor);

  const detail = await salesDetail(actor, {
    from: date,
    to: date,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  // Back to the report with the range it was left on, not a reset to 30 days.
  const backParams = new URLSearchParams({
    from: sp.from ?? date,
    to: sp.to ?? date,
  });
  if (sp.shopId) backParams.set("shopId", sp.shopId);

  const shiftDay = (days: number) => {
    const d = new Date(`${date}T00:00:00.000Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const dayHref = (iso: string) => {
    const params = new URLSearchParams();
    if (sp.from) params.set("from", sp.from);
    if (sp.to) params.set("to", sp.to);
    if (sp.shopId) params.set("shopId", sp.shopId);
    const qs = params.toString();
    return `/reports/sales/${iso}${qs ? `?${qs}` : ""}`;
  };

  const previous = shiftDay(-1);
  const next = shiftDay(1);
  // Never offer a day that cannot have sales yet (§4.2).
  const canGoNext = next <= actor.businessDate.toISOString().slice(0, 10);

  const heading = new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        size="sm"
        render={<Link href={`/reports/sales?${backParams.toString()}`} />}
      >
        <ArrowLeft className="size-4" />
        Daily sales summary
      </Button>

      <ReportShell
        title={heading}
        description={actor.isOwner && !sp.shopId ? "All shops" : undefined}
        from={date}
        to={date}
        shopId={sp.shopId}
        {...filters}
        hideDateControls
      >
        <div className="flex gap-2">
          <Button variant="outline" size="sm" render={<Link href={dayHref(previous)} />}>
            Previous day
          </Button>
          {canGoNext && (
            <Button variant="outline" size="sm" render={<Link href={dayHref(next)} />}>
              Next day
            </Button>
          )}
        </div>

        <ReportTotals
          items={[
            { label: "Revenue", value: formatMoney(detail.revenue) },
            { label: "Transactions", value: formatAmount(detail.transactions) },
            {
              label: "Average sale",
              value: formatMoney(detail.averageTransactionValue),
            },
            {
              label: "Cash / card",
              value: `${formatMoney(detail.cash)} · ${formatMoney(detail.edc)}`,
            },
          ]}
        />

        <SalesDetailTable
          rows={detail.rows}
          transactions={detail.transactions}
          truncated={detail.truncated}
          empty="No sales were recorded on this day."
        />
      </ReportShell>
    </div>
  );
}
