import { requireOwnerPage, asPageError } from "@/server/auth/page-guard";
import { profitReport } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Profit & Loss · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Profit & Loss per Shop (§9).
 *
 * OWNER only, at the page guard AND again inside `profitReport` — CLAUDE.md is
 * explicit that even a Purchasing manager is refused profit and margin. Two
 * checks because a page guard protects a route and a service invariant
 * protects the data (D-55).
 */
export default async function ProfitReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const { rows, combined } = await profitReport(actor, {
    from,
    to,
    ...(sp.shopId ? { shopId: sp.shopId } : {}),
  }).catch(asPageError);

  return (
    <ReportShell
      title="Profit & Loss per Shop"
      description="Revenue less prize expense, shrinkage and operating costs"
      from={from}
      to={to}
      exportName="profit"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          { label: "Revenue", value: formatMoney(combined.revenue) },
          {
            label: "Gross profit",
            value: formatMoney(combined.grossProfit),
            hint: "Revenue − prize − shrinkage",
          },
          {
            label: "Operating expenses",
            value: formatMoney(combined.operatingExpenses),
          },
          {
            label: "Net profit",
            value: formatMoney(combined.netProfit),
            hint: "Gross − operating",
          },
        ]}
      />

      <ReportTable
        rows={rows}
        getKey={(r) => r.shopId}
        columns={[
          { header: "Shop", cell: (r) => r.shopName },
          { header: "Revenue", cell: (r) => formatMoney(r.revenue), numeric: true },
          {
            header: "Prize expense",
            cell: (r) => formatMoney(r.prizeExpense),
            numeric: true,
          },
          {
            // Separate from prize expense on purpose — §9 says mixing them
            // hides theft.
            header: "Shrinkage",
            cell: (r) => formatMoney(r.shrinkageExpense),
            numeric: true,
          },
          {
            header: "Operating",
            cell: (r) => formatMoney(r.operatingExpenses),
            numeric: true,
          },
          {
            header: "Gross profit",
            cell: (r) => formatMoney(r.grossProfit),
            numeric: true,
          },
          {
            header: "Net profit",
            cell: (r) => formatMoney(r.netProfit),
            numeric: true,
          },
        ]}
      />
    </ReportShell>
  );
}
