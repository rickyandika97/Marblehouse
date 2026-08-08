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

  return (
    <ReportShell
      title="Daily Sales Summary"
      description={actor.role === "OWNER" && !sp.shopId ? "All shops" : undefined}
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
              { header: "Shop", cell: (r) => r.shopName },
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
              { header: "Staff", cell: (r) => r.displayName },
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
            { header: "Business date", cell: (r) => r.businessDate },
            { header: "Sales", cell: (r) => formatAmount(r.transactions), numeric: true },
            { header: "Revenue", cell: (r) => formatMoney(r.revenue), numeric: true },
          ]}
        />
      </div>
    </ReportShell>
  );
}
