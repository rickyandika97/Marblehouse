import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { liabilityReport } from "@/server/services/reports";
import { ReportShell, ReportTotals, formatAmount, formatMoney, rangeFrom } from "../report-shell";

export const metadata = { title: "Liability · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Liability (§9, and the owner note in §4.6).
 *
 * Outstanding marbles and tickets are money already collected for value not
 * yet delivered. §4.6 is blunt about why this screen matters: ignoring it
 * makes early months look more profitable than they are.
 *
 * The VALUED half is owner-only — `liabilityReport` returns null for those
 * fields to anyone else, so a manager sees quantities and an explanation
 * rather than a blank space.
 */
export default async function LiabilityReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);

  const report = await liabilityReport(actor, {
    from,
    to,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  const items = [
    {
      label: "Outstanding marbles",
      value: formatAmount(report.outstandingMarbles),
      hint: "Held for customers",
    },
    {
      label: "Outstanding tickets",
      value: formatAmount(report.outstandingTickets),
      hint: "Redeemable at any branch",
    },
    {
      label: "Tickets awarded",
      value: formatAmount(report.ticketsAwarded),
      hint: "In this period",
    },
    {
      label: "Tickets redeemed",
      value: formatAmount(report.ticketsRedeemed),
      hint: "In this period",
    },
  ];

  // Present only for an owner. Rendering these as "—" for a manager would
  // advertise a figure they cannot have; omitting the tiles is cleaner.
  if (report.estimatedTicketLiability !== null) {
    items.push({
      label: "Est. ticket liability",
      value: formatMoney(report.estimatedTicketLiability),
      hint: "Memo line, not booked",
    });
  }
  if (report.blendedCogsPerTicket !== null) {
    items.push({
      label: "Blended COGS per ticket",
      value: formatMoney(report.blendedCogsPerTicket),
      hint: "Trailing 90 days",
    });
  }

  return (
    <ReportShell
      title="Liability"
      description="What the business still owes its customers"
      from={from}
      to={to}
      exportName="liability"
      shopId={sp.shopId}
    >
      <ReportTotals items={items} />

      <p className="max-w-2xl text-sm text-muted-foreground">
        Outstanding balances are global — a marble deposited at one branch is
        withdrawable at any other — so these totals cover the whole business
        regardless of the shop filter. The ticket and marble counts in this
        period are shop-scoped, because a ledger row records where the liability
        was created.
      </p>
    </ReportShell>
  );
}
