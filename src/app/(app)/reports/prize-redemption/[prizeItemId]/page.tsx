import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { prizeRedemptionDetail } from "@/server/services/reports";
import { Button } from "@/components/ui/button";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../../report-shell";

export const metadata = { title: "Prize redemptions · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Prize Redemption → the individual redemptions of one prize (§9 drill-down).
 *
 * Tapping a prize answers "who took these home, and when" — the question the
 * aggregate raises and cannot settle. Each row links to the customer, so an
 * unusual number has somewhere to go next.
 *
 * **The cost column is driven by the data, never by a role check here.** The
 * service returns `cost: null` for a viewer who may not see it, having never
 * read the column; this page renders the column only when a figure exists.
 * D-63 is explicit that a DTO and its renderer must branch on the *same*
 * predicate — two nearly-identical gates that disagree is worse than one.
 */
export default async function PrizeRedemptionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ prizeItemId: string }>;
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const { prizeItemId } = await params;
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const detail = await prizeRedemptionDetail(actor, {
    from,
    to,
    prizeItemId,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  const showCost = detail.totalCost !== null;

  const backParams = new URLSearchParams({ from, to });
  if (sp.shopId) backParams.set("shopId", sp.shopId);

  return (
    <div className="space-y-5">
      <Button
        variant="ghost"
        size="sm"
        render={<Link href={`/reports/prize-redemption?${backParams.toString()}`} />}
      >
        <ArrowLeft className="size-4" />
        Prize redemption
      </Button>

      <ReportShell
        title={detail.prize.name}
        description={actor.isOwner && !sp.shopId ? "All shops" : undefined}
        from={from}
        to={to}
        shopId={sp.shopId}
        {...filters}
      >
        <ReportTotals
          items={[
            { label: "Given", value: formatAmount(detail.qty) },
            { label: "Redemptions", value: formatAmount(detail.redemptions) },
            { label: "Tickets spent", value: formatAmount(detail.tickets) },
            ...(showCost
              ? [
                  {
                    label: "Prize cost",
                    value: formatMoney(detail.totalCost!),
                    hint: "FIFO cost of what went out",
                  },
                ]
              : []),
          ]}
        />

        <ReportTable
          rows={detail.rows}
          getKey={(r, i) => `${r.redemptionId}:${i}`}
          empty="This prize was not redeemed in this period."
          columns={[
            {
              header: "When",
              cell: (r) => (
                <span className="whitespace-nowrap">
                  <span className="block tabular-nums">{r.businessDate}</span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {new Date(r.occurredAt).toLocaleTimeString("en-GB", {
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "Asia/Jakarta",
                    })}
                  </span>
                </span>
              ),
            },
            {
              header: "Customer",
              cell: (r) => (
                <Link
                  href={`/customers/${r.customer.id}`}
                  className="font-medium hover:underline"
                >
                  {r.customer.name}
                </Link>
              ),
            },
            {
              header: "Shop",
              cell: (r) => (
                <span className="text-muted-foreground">{r.shopName}</span>
              ),
            },
            {
              header: "Given by",
              cell: (r) => (
                <span className="text-muted-foreground">{r.staffName}</span>
              ),
            },
            { header: "Qty", cell: (r) => formatAmount(r.qty), numeric: true },
            {
              header: "Tickets",
              cell: (r) => formatAmount(r.tickets),
              numeric: true,
            },
            // Absent entirely for a viewer without cost access — not blanked,
            // not zeroed (D-63).
            ...(showCost
              ? [
                  {
                    header: "Cost",
                    cell: (r: (typeof detail.rows)[number]) =>
                      r.cost === null ? "—" : formatMoney(r.cost),
                    numeric: true,
                  },
                ]
              : []),
          ]}
        />

        {detail.truncated && (
          <p className="text-sm text-muted-foreground">
            Showing the most recent 500 redemptions of{" "}
            {formatAmount(detail.redemptions)}. Narrow the date range to see the
            rest.
          </p>
        )}
      </ReportShell>
    </div>
  );
}
