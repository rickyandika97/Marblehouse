import { Prisma } from "@prisma/client";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { expenseReport } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Expense Report · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Expense Report (§9) — operating expenses by category.
 *
 * Manager-safe. Operating expenses are NOT a cost-of-goods figure: §7.5 gates
 * prize COGS and stock valuation, while §9's "operating expenses" is rent,
 * electricity and wages, which a branch manager is expected to manage. So this
 * is `requireManagerOrOwnerPage`, and `resolveScope` narrows a manager to their
 * own branch in SQL.
 *
 * Soft-deleted expenses are excluded by the service (`isDeleted: false`), which
 * is what makes this total agree with the P&L screen's operating-expense line.
 * If the two ever disagree, look for a query that forgot that filter.
 */
export default async function ExpenseReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);
  const input = { from, to, ...(sp.shopId ? { shopId: sp.shopId } : {}) };

  const { rows, total } = await expenseReport(actor, input).catch(asPageError);

  const totalDec = new Prisma.Decimal(total);
  const share = (amount: string) =>
    totalDec.isZero()
      ? "—"
      : `${new Prisma.Decimal(amount).div(totalDec).mul(100).toFixed(1)}%`;

  const entries = rows.reduce((s, r) => s + r.count, 0);
  const biggest = rows[0];

  return (
    <ReportShell
      title="Expense Report"
      description={actor.role === "OWNER" && !sp.shopId ? "All shops" : undefined}
      from={from}
      to={to}
      exportName="expenses"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          { label: "Total expenses", value: formatMoney(total) },
          { label: "Categories used", value: formatAmount(rows.length) },
          { label: "Entries", value: formatAmount(entries) },
          {
            label: "Largest category",
            value: biggest ? formatMoney(biggest.amount) : "—",
            hint: biggest?.categoryName,
          },
        ]}
      />

      <ReportTable
        rows={rows}
        getKey={(r) => r.categoryId}
        empty="No expenses recorded in this period."
        columns={[
          { header: "Category", cell: (r) => r.categoryName },
          {
            header: "Entries",
            cell: (r) => formatAmount(r.count),
            numeric: true,
          },
          { header: "Share", cell: (r) => share(r.amount), numeric: true },
          {
            header: "Amount",
            cell: (r) => formatMoney(r.amount),
            numeric: true,
          },
        ]}
      />

      <p className="text-sm text-muted-foreground">
        Deleted expenses are excluded. Costs booked to HQ rather than a branch
        appear only when no single branch is selected.
      </p>
    </ReportShell>
  );
}
