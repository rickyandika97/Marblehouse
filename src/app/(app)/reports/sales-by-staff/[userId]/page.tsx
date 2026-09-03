import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { staffSalesDetail } from "@/server/services/reports";
import { Button } from "@/components/ui/button";
import {
  ReportShell,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../../report-shell";
import { SalesDetailTable } from "../../sales-detail-table";

export const metadata = { title: "Staff sales · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Sales by Staff → one person's transactions (§9 drill-down).
 *
 * Tapping a name on Sales by Staff lands here with the range and shop filter
 * carried over in the URL, so the totals at the top reconcile exactly with the
 * row that was tapped. Changing the range from the filter bar re-runs the same
 * service — the page holds no client state.
 *
 * Permission is `salesDetail`'s `resolveScope`, in SQL, not this guard:
 * `requireManagerOrOwnerPage` is a coarse pre-filter that says nothing about
 * WHICH shop's rows the caller may read (D-138).
 */
export default async function StaffSalesDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ userId: string }>;
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { userId } = await params;
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const detail = await staffSalesDetail(actor, {
    from,
    to,
    userId,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  // Preserve the range and shop when going back, so the report is the one that
  // was left rather than a reset to the default 30 days.
  const backParams = new URLSearchParams({ from, to });
  if (sp.shopId) backParams.set("shopId", sp.shopId);

  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        size="sm"
        render={<Link href={`/reports/sales-by-staff?${backParams.toString()}`} />}
      >
        <ArrowLeft className="size-4" />
        Sales by staff
      </Button>

      <ReportShell
        title={detail.staff.displayName}
        description={actor.isOwner && !sp.shopId ? "All shops" : undefined}
        from={from}
        to={to}
        shopId={sp.shopId}
        {...filters}
      >
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
          omit={["staff"]}
          empty="This person recorded no sales in this period."
        />
      </ReportShell>
    </div>
  );
}
