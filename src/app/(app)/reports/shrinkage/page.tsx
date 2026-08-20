import { Prisma } from "@prisma/client";
import { requireManagerOrOwnerPage, asPageError } from "@/server/auth/page-guard";
import { shrinkageReport } from "@/server/services/reports";
import {
  ReportShell,
  ReportTable,
  ReportTotals,
  formatAmount,
  formatMoney,
  rangeFrom,
  filterPropsFor,
} from "../report-shell";

export const metadata = { title: "Shrinkage · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * Shrinkage Report (§9) — stock that left without being redeemed.
 *
 * Cost-bearing, so `shrinkageReport` gates on `assertCanSeeCost`: the OWNER
 * sees every branch, a Purchasing manager sees their own, a plain manager gets
 * a real 403 through `asPageError` (D-64). The page guard is
 * manager-or-owner rather than owner-only because a Purchasing manager is
 * legitimately allowed here for their own shops (§7.5, and D-34's bug).
 *
 * **The two causes are shown as separate columns on purpose.** §9 keeps
 * shrinkage out of prize expense because "mixing it into prize expense hides
 * theft"; splitting declared DAMAGE from discovered OPNAME_LOSS is the same
 * argument one level down. Damage has a name attached at the moment it
 * happened. An opname loss is what a physical count found missing, with nobody
 * accountable — so a branch whose shrinkage is nearly all opname loss is the
 * one to visit, and that signal disappears the moment the columns are merged.
 */
export default async function ShrinkageReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shopId?: string }>;
}) {
  const actor = await requireManagerOrOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);
  const input = { from, to, ...(sp.shopId ? { shopId: sp.shopId } : {}) };

  const report = await shrinkageReport(actor, input).catch(asPageError);

  const total = new Prisma.Decimal(report.totalShrinkage);
  const share = (amount: string) =>
    total.isZero()
      ? "—"
      : `${new Prisma.Decimal(amount).div(total).mul(100).toFixed(1)}%`;

  return (
    <ReportShell
      title="Shrinkage"
      description={actor.isOwner && !sp.shopId ? "All shops" : undefined}
      from={from}
      to={to}
      exportName="shrinkage"
      shopId={sp.shopId}
      {...filters}
    >
      <ReportTotals
        items={[
          {
            label: "Total shrinkage",
            value: formatMoney(report.totalShrinkage),
            hint: `${formatAmount(report.totalUnits)} units`,
          },
          {
            label: "Lost at count",
            value: formatMoney(report.opnameLoss),
            hint: `${share(report.opnameLoss)} — nobody accountable`,
          },
          {
            label: "Damaged",
            value: formatMoney(report.damage),
            hint: `${share(report.damage)} — declared at the time`,
          },
          {
            label: "Branches affected",
            value: formatAmount(report.byShop.length),
          },
        ]}
      />

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">By branch</h2>
        <ReportTable
          rows={report.byShop}
          getKey={(r) => r.shopId}
          empty="No stock was lost or damaged in this period."
          columns={[
            { header: "Shop", cell: (r) => r.shopName },
            { header: "Units", cell: (r) => formatAmount(r.qty), numeric: true },
            { header: "Share", cell: (r) => share(r.value), numeric: true },
            {
              header: "Value lost",
              cell: (r) => formatMoney(r.value),
              numeric: true,
            },
          ]}
        />
      </div>

      <div className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">By item</h2>
        <ReportTable
          rows={report.byItem}
          getKey={(r) => r.prizeItemId}
          empty="No stock was lost or damaged in this period."
          columns={[
            { header: "Prize", cell: (r) => r.prizeName },
            { header: "Units", cell: (r) => formatAmount(r.qty), numeric: true },
            {
              header: "Lost at count",
              cell: (r) => formatMoney(r.opnameLossValue),
              numeric: true,
            },
            {
              header: "Damaged",
              cell: (r) => formatMoney(r.damageValue),
              numeric: true,
            },
            {
              header: "Total",
              cell: (r) => formatMoney(r.value),
              numeric: true,
            },
          ]}
        />
      </div>

      <p className="text-sm text-muted-foreground">
        Valued at the cost the stock was actually bought at (FIFO), not a
        current average. Prizes handed to customers are <strong>not</strong>{" "}
        shrinkage — those are in the Prize Expense report.
      </p>
    </ReportShell>
  );
}
