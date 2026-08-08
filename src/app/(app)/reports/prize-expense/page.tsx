import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { prizeExpenseReport } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Prize Expense · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Prize Expense, FIFO (§9).
 *
 * The page guard is manager-or-owner rather than owner-only because a
 * PURCHASING manager legitimately reaches this for their own shops (§7.5).
 * The real gate is `assertCanSeeCost` inside the service, which refuses a
 * plain manager and refuses any scope containing a shop they do not manage.
 */
export default async function PrizeExpenseReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  // The cost gate lives in the service and throws AppError (CLAUDE.md rule 10).
  // A page has no `handleRoute` to convert that, so an uncaught throw renders a
  // 500 instead of a 403 — `asPageError` is what turns it into a real
  // forbidden() page. Found by loading this route as a plain manager.
  const report = await prizeExpenseReport(actor, {
    from,
    to,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  return (
    <ReportShell
      title="Prize Expense (FIFO)"
      description="The true cost of prizes handed out"
      from={from}
      to={to}
      exportName="prize-expense"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          {
            label: "Prize expense",
            value: formatMoney(report.prizeExpense),
            hint: "Redemptions only",
          },
          {
            label: "Shrinkage",
            value: formatMoney(report.shrinkageExpense),
            hint: "Opname loss and damage",
          },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        Each figure is the sum of the cost recorded at the moment each batch was
        consumed — never a recomputed average, so it does not change when new
        stock arrives at a different price.
      </p>

      <ReportTable
        rows={report.byItem}
        getKey={(r) => r.prizeItemId}
        empty="No prizes were redeemed in this period."
        columns={[
          { header: "Prize", cell: (r) => r.prizeName },
          { header: "Quantity", cell: (r) => formatAmount(r.qty), numeric: true },
          { header: "Expense", cell: (r) => formatMoney(r.expense), numeric: true },
        ]}
      />
    </ReportShell>
  );
}
