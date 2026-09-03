import Link from "next/link";
import { Prisma } from "@prisma/client";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { salesSummary } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Payment Method Breakdown · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Payment Method Breakdown (§9).
 *
 * Cash vs card/QRIS for the period. `salesSummary` already returns both totals,
 * so this is a presentation of numbers the engine has always produced.
 *
 * **Why an owner actually opens this screen: cash reconciliation.** The cash
 * figure is what should be in the drawer at close. That is why the cash row is
 * first and why the split is shown as a percentage — a branch whose cash share
 * suddenly drops is either genuinely taking more card payments or is not
 * recording cash, and the trend is the only thing that distinguishes them.
 *
 * Manager-safe: no cost figure appears here, and scope is resolved in SQL.
 */
export default async function PaymentMethodsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);
  const input = { from, to, ...(sp.shopId ? { shopId: sp.shopId } : {}) };

  const summary = await salesSummary(actor, input).catch(asPageError);

  const total = new Prisma.Decimal(summary.revenue);
  const share = (amount: string) =>
    total.isZero()
      ? "—"
      : `${new Prisma.Decimal(amount).div(total).mul(100).toFixed(1)}%`;

  const rows = [
    { method: "Cash", slug: "cash", amount: summary.cash },
    { method: "Card / QRIS", slug: "edc", amount: summary.edc },
  ];

  const detailHref = (slug: string) => {
    const params = new URLSearchParams({ from, to });
    if (sp.shopId) params.set("shopId", sp.shopId);
    return `/reports/payment-methods/${slug}?${params.toString()}`;
  };

  return (
    <ReportShell
      title="Payment Method Breakdown"
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
          {
            label: "Cash",
            value: formatMoney(summary.cash),
            hint: `${share(summary.cash)} of revenue`,
          },
          {
            label: "Card / QRIS",
            value: formatMoney(summary.edc),
            hint: `${share(summary.edc)} of revenue`,
          },
          { label: "Transactions", value: formatAmount(summary.transactions) },
        ]}
      />

      <ReportTable
        rows={rows}
        getKey={(r) => r.method}
        empty="No sales in this period."
        columns={[
          {
            header: "Method",
            cell: (r) => (
              <Link href={detailHref(r.slug)} className="font-medium hover:underline">
                {r.method}
              </Link>
            ),
          },
          { header: "Share", cell: (r) => share(r.amount), numeric: true },
          { header: "Amount", cell: (r) => formatMoney(r.amount), numeric: true },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        Cash is what should be in the drawer at close, before any float or
        payout. Voided sales are already excluded from both figures.
      </p>
    </ReportShell>
  );
}
