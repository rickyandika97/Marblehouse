import { requireOwnerPage } from "@/server/auth/page-guard";
import { listSales, saleEditOptions } from "@/server/services/sales";
import { listEmployees } from "@/server/services/employees";
import { ReportShell, rangeFrom, filterPropsFor } from "../reports/report-shell";
import { AllSalesTable } from "./all-sales-table";

export const metadata = { title: "All Sales · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * All sales — the owner's browsable register of individual transactions (D-181).
 *
 * The §9 reports answer "how much"; this screen answers "which one", and it is
 * the only way to reach a sale that is no longer in today's recent strip. That
 * is what makes it the home of the edit feature rather than a nicety: without
 * it, an owner who spots a wrong figure in last week's report has no route to
 * the row behind it.
 *
 * OWNER only, at the page guard AND at every service it calls. It deliberately
 * shows **voided sales as well as completed ones** — an owner looking for a
 * mistake needs to see the void that was the mistake.
 *
 * Not in the bottom nav: that is full at six tabs (D-36), and Phase 10's own
 * note says the fix is a "More" tab rather than a seventh. It is reached from
 * the Reports index instead.
 */
export default async function AllSalesPage({
  searchParams,
}: {
  searchParams: Promise<{
    from?: string;
    to?: string;
    shopId?: string;
    userId?: string;
    paymentMethod?: string;
    status?: string;
  }>;
}) {
  const actor = await requireOwnerPage();
  const sp = await searchParams;
  const { from, to } = rangeFrom(sp, actor.businessDate);
  const filters = await filterPropsFor(actor);

  const paymentMethod =
    sp.paymentMethod === "CASH" || sp.paymentMethod === "EDC"
      ? sp.paymentMethod
      : undefined;
  const status =
    sp.status === "COMPLETED" || sp.status === "VOIDED" ? sp.status : undefined;

  const [{ sales, nextCursor }, options, employees] = await Promise.all([
    listSales(actor, {
      from,
      to,
      ...(sp.shopId ? { shopId: sp.shopId } : {}),
      ...(sp.userId ? { userId: sp.userId } : {}),
      ...(paymentMethod ? { paymentMethod } : {}),
      ...(status ? { status } : {}),
    }),
    saleEditOptions(actor),
    listEmployees(actor),
  ]);

  return (
    <ReportShell
      title="All Sales"
      description="Every transaction, including voided ones"
      from={from}
      to={to}
      shopId={sp.shopId}
      {...filters}
    >
      <AllSalesTable
        sales={sales}
        options={options}
        staff={employees
          .filter((e) => e.isActive)
          .map((e) => ({ id: e.id, displayName: e.displayName }))}
        hasMore={nextCursor !== null}
        selected={{
          userId: sp.userId,
          paymentMethod,
          status,
        }}
      />
    </ReportShell>
  );
}
