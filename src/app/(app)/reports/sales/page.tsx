import Link from "next/link";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { dailySales, salesByShop, salesByStaff, salesSummary } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Daily Sales Summary · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Daily Sales Summary (§9).
 *
 * Manager-safe: nothing on this page is a cost figure. A manager's scope is
 * resolved to their own shop by `resolveScope` and cannot be widened from the
 * query string.
 */
export default async function SalesReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);
  const input = { from, to, ...(sp.shopId ? { shopId: sp.shopId } : {}) };

  // A foreign shopId in the query string throws FORBIDDEN from the service;
  // asPageError renders a real 403 instead of a 500.
  const [summary, daily, byShop, byStaff] = await Promise.all([
    salesSummary(actor, input),
    dailySales(actor, input),
    salesByShop(actor, input),
    salesByStaff(actor, input),
  ]).catch(asPageError);

  // Each table drills into the same detail its own standalone report does, so
  // a figure means the same thing wherever it is tapped. The current range and
  // shop ride along, and the day link additionally carries the range so its
  // back button returns to this screen rather than resetting it.
  const withFilters = (base: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams({ from, to, ...extra });
    if (sp.shopId) params.set("shopId", sp.shopId);
    return `${base}?${params.toString()}`;
  };

  return (
    <ReportShell
      title="Daily Sales Summary"
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
          {
            label: "Average sale",
            value: formatMoney(summary.averageTransactionValue),
          },
          {
            label: "Customers",
            value: formatAmount(summary.uniqueCustomers),
            hint: `${formatAmount(summary.walkInTransactions)} walk-in sales`,
          },
        ]}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">By shop</h2>
          <ReportTable
            rows={byShop.rows}
            getKey={(r) => r.shopId}
            columns={[
              {
                header: "Shop",
                // The shop drill-down scopes BY the shop, so it takes only the
                // range — a shopId as well would be the same filter twice.
                cell: (r) => (
                  <Link
                    href={`/reports/sales-by-shop/${r.shopId}?${new URLSearchParams({ from, to }).toString()}`}
                    className="font-medium hover:underline"
                  >
                    {r.shopName}
                  </Link>
                ),
              },
              { header: "Sales", cell: (r) => formatAmount(r.transactions), numeric: true },
              { header: "Revenue", cell: (r) => formatMoney(r.revenue), numeric: true },
            ]}
          />
        </div>

        <div className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">By staff</h2>
          <ReportTable
            rows={byStaff.rows}
            getKey={(r) => r.userId}
            columns={[
              {
                header: "Staff",
                cell: (r) => (
                  <Link
                    href={withFilters(`/reports/sales-by-staff/${r.userId}`)}
                    className="font-medium hover:underline"
                  >
                    {r.displayName}
                  </Link>
                ),
              },
              { header: "Sales", cell: (r) => formatAmount(r.transactions), numeric: true },
              { header: "Revenue", cell: (r) => formatMoney(r.revenue), numeric: true },
            ]}
          />
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">By day</h2>
        <ReportTable
          rows={[...daily.rows].reverse()}
          getKey={(r) => r.businessDate}
          columns={[
            {
              header: "Business date",
              cell: (r) => (
                <Link
                  href={withFilters(`/reports/sales/${r.businessDate}`)}
                  className="font-medium hover:underline"
                >
                  {r.businessDate}
                </Link>
              ),
            },
            { header: "Sales", cell: (r) => formatAmount(r.transactions), numeric: true },
            { header: "Revenue", cell: (r) => formatMoney(r.revenue), numeric: true },
          ]}
        />
      </div>
    </ReportShell>
  );
}
