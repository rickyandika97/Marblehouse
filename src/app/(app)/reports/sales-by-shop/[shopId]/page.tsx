import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { salesDetail } from "@/server/services/reports";
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

export const metadata = { title: "Shop sales · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Sales by Shop → one branch's transactions (§9 drill-down).
 *
 * **The shop id is the SCOPE, not a filter applied after one.** It goes in as
 * `shopId`, so `resolveScope` validates it the same way it validates the
 * picker's — a manager reaching another branch by editing the URL gets a 403,
 * and an owner's typo gets a 404 rather than a calm page of zeroes (R-4). That
 * is also why this page needs no shop lookup of its own for permission; the
 * name below is only for the title.
 */
export default async function ShopSalesDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ shopId: string }>;
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { shopId } = await params;
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const detail = await salesDetail(actor, { from, to, shopId }).catch(asPageError);

  // `resolveScope` has already proven this shop is real and permitted, so the
  // name is a label lookup rather than a second gate.
  const shopName =
    filters.shops.find((s) => s.id === shopId)?.name ?? "This shop";

  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        size="sm"
        render={
          <Link
            href={`/reports/sales-by-shop?${new URLSearchParams({ from, to }).toString()}`}
          />
        }
      >
        <ArrowLeft className="size-4" />
        Sales by shop
      </Button>

      <ReportShell
        title={shopName}
        from={from}
        to={to}
        shopId={shopId}
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
          omit={["shop"]}
          empty="This branch recorded no sales in this period."
        />
      </ReportShell>
    </div>
  );
}
