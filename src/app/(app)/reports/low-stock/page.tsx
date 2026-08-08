import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { lowStockReport } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Low Stock · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Low Stock (§9, §8.7).
 *
 * Quantities only — no cost — so every manager may read it for their own shop.
 * A threshold of 0 means "no alert" and is excluded in SQL, so an item nobody
 * wants warnings about never appears here even at zero stock (§4.8).
 */
export default async function LowStockReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const { rows } = await lowStockReport(actor, {
    from,
    to,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  const out = rows.filter((r) => r.onHand === 0).length;

  return (
    <ReportShell
      title="Low Stock"
      description="Items at or below their branch threshold"
      from={from}
      to={to}
      exportName="low-stock"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          { label: "Items flagged", value: formatAmount(rows.length) },
          {
            label: "Out of stock",
            value: formatAmount(out),
            hint: "Nothing on hand at all",
          },
        ]}
      />

      <ReportTable
        rows={rows}
        getKey={(r) => `${r.shopId}:${r.prizeItemId}`}
        empty="Nothing is below its threshold. Stock levels are healthy."
        columns={[
          { header: "Shop", cell: (r) => r.shopName },
          { header: "Prize", cell: (r) => r.prizeName },
          {
            header: "On hand",
            cell: (r) => (
              <span className={r.onHand === 0 ? "font-semibold text-red-600" : undefined}>
                {formatAmount(r.onHand)}
              </span>
            ),
            numeric: true,
          },
          {
            header: "Threshold",
            cell: (r) => formatAmount(r.lowStockThreshold),
            numeric: true,
          },
        ]}
      />
    </ReportShell>
  );
}
