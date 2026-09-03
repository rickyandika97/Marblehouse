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
  rangeFrom,
  filterPropsFor,
} from "../../report-shell";
import { SalesDetailTable } from "../../sales-detail-table";

export const metadata = { title: "Payment method · Marblehouse" };
export const dynamic = "force-dynamic";

/** The URL segment is lowercase for readability; the column is not. */
const METHODS = {
  cash: { value: "CASH", label: "Cash", empty: "cash" },
  // `empty` is a separate word rather than a lowercased `label`, because
  // lowercasing "Card / QRIS" mangles the acronym into "card / qris".
  edc: { value: "EDC", label: "Card / QRIS", empty: "card or QRIS" },
} as const;

/**
 * Payment Method Breakdown → the sales paid that way (§9 drill-down).
 *
 * The cash list is the one an owner actually reconciles against the drawer at
 * close, which is the whole reason this screen is worth drilling into: "the
 * cash figure is Rp 2.6jt" is not checkable, but a list of the sales making it
 * up is.
 *
 * **The method comes off a fixed map, never straight into the query.** It is a
 * URL segment, so anything can arrive; an unrecognised one is a 404 rather
 * than a filter Prisma would reject at runtime.
 */
export default async function PaymentMethodDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ method: string }>;
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { method } = await params;
  const sp = await searchParams;

  const chosen = METHODS[method.toLowerCase() as keyof typeof METHODS];
  if (!chosen) notFound();

  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const detail = await salesDetail(actor, {
    from,
    to,
    paymentMethod: chosen.value,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  const backParams = new URLSearchParams({ from, to });
  if (sp.shopId) backParams.set("shopId", sp.shopId);

  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        size="sm"
        render={<Link href={`/reports/payment-methods?${backParams.toString()}`} />}
      >
        <ArrowLeft className="size-4" />
        Payment methods
      </Button>

      <ReportShell
        title={chosen.label}
        description={actor.isOwner && !sp.shopId ? "All shops" : undefined}
        from={from}
        to={to}
        shopId={sp.shopId}
        {...filters}
      >
        <ReportTotals
          items={[
            { label: "Amount", value: formatMoney(detail.revenue) },
            { label: "Transactions", value: formatAmount(detail.transactions) },
            {
              label: "Average sale",
              value: formatMoney(detail.averageTransactionValue),
            },
          ]}
        />

        <SalesDetailTable
          rows={detail.rows}
          transactions={detail.transactions}
          truncated={detail.truncated}
          // Every row here is the method that was drilled into.
          omit={["paid"]}
          empty={`No ${chosen.empty} sales in this period.`}
        />
      </ReportShell>
    </div>
  );
}
