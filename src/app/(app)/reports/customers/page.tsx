import { requireOwnerPage, asPageError } from "@/server/auth/page-guard";
import { customerReport } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Customer Spend Leaderboard · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Customer Spend Leaderboard (§9) — OWNER only.
 *
 * `customerReport` calls `assertOwner` itself, so the page guard here is about
 * rendering a real 403 rather than a 500 (D-64); it is not what enforces the
 * rule. Lifetime value and visit history are owner-only for the same reason
 * `toCustomerOwnerDTO` exists (§7.5, Phase 2) — spend history is commercially
 * sensitive in a way a customer's balance is not.
 *
 * **The service caps at 200 rows by construction**, which is why this screen
 * has no pagination: it is a leaderboard, and the 201st customer is not one.
 * Lifetime value is all-time by §9's definition, so it deliberately does NOT
 * move with the date range — only the ranking window does. The copy under the
 * table says so, because a figure that ignores the filter above it looks like
 * a bug otherwise.
 */
export default async function CustomerLeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);
  const input = { from, to, ...(sp.shopId ? { shopId: sp.shopId } : {}) };

  const { rows } = await customerReport(actor, input).catch(asPageError);

  // Marble and ticket balances are integer counts, not money, so plain
  // addition is correct here. Nothing on this page sums a Decimal in JS.
  const totalMarbles = rows.reduce((s, r) => s + r.marbleBalance, 0);
  const totalTickets = rows.reduce((s, r) => s + r.ticketBalance, 0);

  return (
    <ReportShell
      title="Customer Spend Leaderboard"
      description={!sp.shopId ? "All shops" : undefined}
      from={from}
      to={to}
      exportName="customers"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          { label: "Customers ranked", value: formatAmount(rows.length) },
          {
            label: "Top customer",
            value: rows[0] ? formatMoney(rows[0].lifetimeValue) : "—",
            hint: rows[0]?.name,
          },
          {
            label: "Outstanding marbles",
            value: formatAmount(totalMarbles),
            hint: "held by these customers",
          },
          {
            label: "Outstanding tickets",
            value: formatAmount(totalTickets),
            hint: "held by these customers",
          },
        ]}
      />

      <ReportTable
        rows={rows}
        getKey={(r) => r.customerId}
        empty="No identified customers bought anything in this period."
        columns={[
          { header: "Customer", cell: (r) => r.name },
          { header: "Phone", cell: (r) => r.phone },
          {
            header: "Visits",
            cell: (r) => formatAmount(r.transactions),
            numeric: true,
          },
          {
            header: "Active days",
            cell: (r) => formatAmount(r.activeDays),
            numeric: true,
          },
          {
            header: "Marbles",
            cell: (r) => formatAmount(r.marbleBalance),
            numeric: true,
          },
          {
            header: "Tickets",
            cell: (r) => formatAmount(r.ticketBalance),
            numeric: true,
          },
          {
            header: "Lifetime value",
            cell: (r) => formatMoney(r.lifetimeValue),
            numeric: true,
          },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        Ranked by spend within the selected period. <strong>Lifetime value is
        all-time</strong> (§9) and does not change with the dates above. Walk-in
        sales have no customer attached and cannot appear here.
      </p>
    </ReportShell>
  );
}
