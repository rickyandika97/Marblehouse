import Link from "next/link";
import { Prisma } from "@prisma/client";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { salesByShop, salesSummary } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Sales by Shop · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Sales by Shop (§9).
 *
 * Most useful to an OWNER comparing branches — but a manager assigned to more
 * than one branch has a real use for it too, so this is not owner-gated. What
 * stops a manager seeing someone else's branch is `resolveScope`, in SQL, not
 * this page (§3.4, D-60).
 *
 * The share column is a percentage of period revenue, computed in `Decimal`.
 * It answers the question the raw figures do not: whether a quiet branch is
 * quiet in absolute terms or only relative to a very busy one.
 */
export default async function SalesByShopPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);
  const input = { from, to, ...(sp.shopId ? { shopId: sp.shopId } : {}) };

  const [summary, byShop] = await Promise.all([
    salesSummary(actor, input),
    salesByShop(actor, input),
  ]).catch(asPageError);

  // The drill-down scopes BY the shop, so it carries only the range — a
  // shopId in the query string would be the same filter twice.
  const detailHref = (shopId: string) =>
    `/reports/sales-by-shop/${shopId}?${new URLSearchParams({ from, to }).toString()}`;

  const total = new Prisma.Decimal(summary.revenue);
  const share = (revenue: string) =>
    total.isZero()
      ? "—"
      : `${new Prisma.Decimal(revenue).div(total).mul(100).toFixed(1)}%`;

  return (
    <ReportShell
      title="Sales by Shop"
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
          { label: "Branches", value: formatAmount(byShop.rows.length) },
          {
            label: "Average sale",
            value: formatMoney(summary.averageTransactionValue),
          },
        ]}
      />

      <ReportTable
        rows={byShop.rows}
        getKey={(r) => r.shopId}
        empty="No sales at any branch in this period."
        columns={[
          {
            header: "Shop",
            cell: (r) => (
              <Link href={detailHref(r.shopId)} className="font-medium hover:underline">
                {r.shopName}
              </Link>
            ),
          },
          {
            header: "Sales",
            cell: (r) => formatAmount(r.transactions),
            numeric: true,
          },
          { header: "Share", cell: (r) => share(r.revenue), numeric: true },
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
