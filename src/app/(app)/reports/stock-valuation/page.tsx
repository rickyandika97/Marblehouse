import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { stockValuation } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Stock Valuation · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Stock Valuation (§9). Cost-gated in the service — owner, or a Purchasing
 * manager for their own shops.
 *
 * This is a point-in-time figure about stock that exists NOW, so the service
 * deliberately ignores the date range. The range is still shown because the
 * shell displays it, but it does not filter the number.
 */
export default async function StockValuationReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  // Cost-gated in the service; asPageError turns its AppError into a real 403
  // page rather than a 500 (see prize-expense for the full note).
  const { rows, total } = await stockValuation(actor, {
    from,
    to,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  return (
    <ReportShell
      title="Stock Valuation"
      description="Value of prize stock on hand right now"
      from={from}
      to={to}
      exportName="stock-valuation"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          { label: "Total stock value", value: formatMoney(total) },
          {
            label: "Units on hand",
            value: formatAmount(rows.reduce((n, r) => n + r.units, 0)),
          },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        A current snapshot — the date range above does not affect these figures.
        Quantity on hand is always summed from live batches.
      </p>

      <ReportTable
        rows={rows}
        getKey={(r) => r.shopId}
        empty="No stock on hand."
        columns={[
          { header: "Shop", cell: (r) => r.shopName },
          { header: "Units", cell: (r) => formatAmount(r.units), numeric: true },
          { header: "Value", cell: (r) => formatMoney(r.value), numeric: true },
        ]}
      />
    </ReportShell>
  );
}
