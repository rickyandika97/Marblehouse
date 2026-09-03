import Link from "next/link";
import { Prisma } from "@prisma/client";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { salesByStaff, salesSummary } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Sales by Staff · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Sales by Staff (§9).
 *
 * Manager-safe: revenue and transaction counts carry no cost figure, and
 * `resolveScope` collapses an unscoped manager to their own shop (D-60).
 *
 * The average column is computed per row rather than taken from a service
 * field, because §9 defines ATV as revenue ÷ transactions and the service
 * already returns both. Two things it deliberately does NOT do:
 *
 * - It does not divide with JS numbers. Money is `Decimal` (§4.1, CLAUDE.md
 *   rule 5), and `Number("12345678901234")` is already lossy before the divide.
 * - It does not divide by zero. A staff member with no sales in the period
 *   renders "—", not `NaN`.
 */
export default async function SalesByStaffPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);
  const input = { from, to, ...(sp.shopId ? { shopId: sp.shopId } : {}) };

  const [summary, byStaff] = await Promise.all([
    salesSummary(actor, input),
    salesByStaff(actor, input),
  ]).catch(asPageError);

  // The drill-down carries the range and shop through, so the detail page's
  // totals reconcile with the row that was tapped rather than resetting to the
  // default 30-day window.
  const detailHref = (userId: string) => {
    const params = new URLSearchParams({ from, to });
    if (sp.shopId) params.set("shopId", sp.shopId);
    return `/reports/sales-by-staff/${userId}?${params.toString()}`;
  };

  const average = (revenue: string, transactions: number) =>
    transactions === 0
      ? "—"
      : formatMoney(new Prisma.Decimal(revenue).div(transactions).toFixed(2));

  return (
    <ReportShell
      title="Sales by Staff"
      description={actor.isOwner && !sp.shopId ? "All shops" : undefined}
      from={from}
      to={to}
      exportName="sales"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          { label: "Revenue", value: formatMoney(summary.revenue) },
          { label: "Transactions", value: formatAmount(summary.transactions) },
          { label: "Staff selling", value: formatAmount(byStaff.rows.length) },
          {
            label: "Average sale",
            value: formatMoney(summary.averageTransactionValue),
          },
        ]}
      />

      <ReportTable
        rows={byStaff.rows}
        getKey={(r) => r.userId}
        empty="Nobody recorded a sale in this period."
        columns={[
          {
            header: "Staff",
            cell: (r) => (
              <Link href={detailHref(r.userId)} className="font-medium hover:underline">
                {r.displayName}
              </Link>
            ),
          },
          {
            header: "Sales",
            cell: (r) => formatAmount(r.transactions),
            numeric: true,
          },
          {
            header: "Average",
            cell: (r) => average(r.revenue, r.transactions),
            numeric: true,
          },
          {
            header: "Revenue",
            cell: (r) => formatMoney(r.revenue),
            numeric: true,
          },
        ]}
      />
    </ReportShell>
  );
}
