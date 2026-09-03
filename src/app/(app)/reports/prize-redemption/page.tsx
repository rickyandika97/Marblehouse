import Link from "next/link";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { prizeRedemptionReport } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Prize Redemption · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Prize Redemption Report (§9) — what customers actually took home.
 *
 * **Not owner-only, and not cost-gated at the top.** Quantities and ticket
 * spend are operational facts a branch manager needs in order to restock, and
 * §7.5 restricts *cost*, not activity. The cost column is resolved per-caller
 * inside the service instead: `cogs` comes back `null` for anyone who may not
 * see it, and the restricted query never reads the column at all.
 *
 * The cost column is therefore rendered conditionally — and the condition is
 * "the service gave me a figure", never a second role check of this page's own.
 * D-63 is explicit that a DTO and its exporter must branch on the *same*
 * predicate; two nearly-identical gates that disagree is worse than one,
 * because the mismatch is invisible until someone reads the output.
 */
export default async function PrizeRedemptionReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);
  const input = { from, to, ...(sp.shopId ? { shopId: sp.shopId } : {}) };

  const report = await prizeRedemptionReport(actor, input).catch(asPageError);

  // One source of truth for "may this viewer see cost", taken from the data.
  const showCost = report.totalCogs !== null;

  const detailHref = (prizeItemId: string) => {
    const params = new URLSearchParams({ from, to });
    if (sp.shopId) params.set("shopId", sp.shopId);
    return `/reports/prize-redemption/${prizeItemId}?${params.toString()}`;
  };

  return (
    <ReportShell
      title="Prize Redemption"
      description={actor.isOwner && !sp.shopId ? "All shops" : undefined}
      from={from}
      to={to}
      exportName="prize-redemption"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          { label: "Redemptions", value: formatAmount(report.redemptions) },
          { label: "Items given", value: formatAmount(report.itemsGiven) },
          { label: "Tickets spent", value: formatAmount(report.ticketsSpent) },
          showCost
            ? {
                label: "Prize cost",
                value: formatMoney(report.totalCogs!),
                hint: "FIFO cost of what went out",
              }
            : {
                label: "Distinct prizes",
                value: formatAmount(report.byItem.length),
              },
        ]}
      />

      <ReportTable
        rows={report.byItem}
        getKey={(r) => r.prizeItemId}
        empty="No prizes were redeemed in this period."
        columns={[
          {
            header: "Prize",
            cell: (r) => (
              <Link
                href={detailHref(r.prizeItemId)}
                className="font-medium hover:underline"
              >
                {r.prizeName}
              </Link>
            ),
          },
          {
            header: "Given",
            cell: (r) => formatAmount(r.qty),
            numeric: true,
          },
          {
            header: "Tickets",
            cell: (r) => formatAmount(r.tickets),
            numeric: true,
          },
          // Absent entirely for a viewer without cost access — not blanked,
          // not zeroed. An empty column promising a figure it can never show
          // is the exact defect D-63 records in the liability export.
          ...(showCost
            ? [
                {
                  header: "Cost",
                  cell: (r: (typeof report.byItem)[number]) =>
                    formatMoney(r.cogs!),
                  numeric: true,
                },
              ]
            : []),
        ]}
      />

      <p className="text-sm text-muted-foreground">
        Voided redemptions are excluded — their stock and tickets went back.
        Tickets are counted at the price charged on the day, so a later price
        change does not rewrite this history.
      </p>
    </ReportShell>
  );
}
