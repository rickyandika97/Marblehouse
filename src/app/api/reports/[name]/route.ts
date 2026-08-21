/**
 * §7.8 GET /api/reports/:name — the JSON form of every §9 report.
 *
 * One route rather than eight near-identical files. Each report's PERMISSION
 * lives in its service (owner-only, cost-gated, or manager-scoped), so this
 * handler stays the three things CLAUDE.md allows: authenticate, validate,
 * call a service.
 *
 * `/api/reports/tickets-awarded` is a separate static route from Phase 3 and
 * takes precedence over this dynamic segment, which is why it is absent below.
 */
import { requireManagerOrOwner } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import { AppError } from "@/server/errors";
import {
  attendanceReport,
  customerReport,
  dailySales,
  expenseReport,
  liabilityReport,
  lowStockReport,
  prizeExpenseReport,
  prizeRedemptionReport,
  profitReport,
  reportRangeSchema,
  salesByShop,
  salesByStaff,
  salesSummary,
  shrinkageReport,
  stockValuation,
  type ReportRangeInput,
} from "@/server/services/reports";
import type { Actor } from "@/server/auth/context";

const REPORTS: Record<
  string,
  (actor: Actor, input: ReportRangeInput) => Promise<unknown>
> = {
  sales: async (actor, input) => ({
    summary: await salesSummary(actor, input),
    daily: (await dailySales(actor, input)).rows,
    byShop: (await salesByShop(actor, input)).rows,
    byStaff: (await salesByStaff(actor, input)).rows,
  }),
  // The `sales` entry above bundles these, but §7.8 gives every §9 report its
  // own address, and the CSV registry already exposes both names. A name that
  // exports but cannot be fetched as JSON is the kind of asymmetry that turns
  // into a 404 for whoever wires up the next screen.
  "sales-by-shop": salesByShop,
  "sales-by-staff": salesByStaff,
  expenses: expenseReport,
  customers: customerReport,
  "prize-expense": prizeExpenseReport,
  "stock-valuation": stockValuation,
  liability: liabilityReport,
  profit: profitReport,
  attendance: attendanceReport,
  "low-stock": lowStockReport,
  shrinkage: shrinkageReport,
  "prize-redemption": prizeRedemptionReport,
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { name } = await params;

    const report = REPORTS[name];
    if (!report) {
      throw new AppError("NOT_FOUND", `There is no report called "${name}".`, {
        available: Object.keys(REPORTS),
      });
    }

    const { searchParams } = new URL(req.url);
    const range = reportRangeSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
    });
    const input =
      name === "attendance" && searchParams.get("outsideSchedule") === "true"
        ? { ...range, outsideSchedule: true }
        : range;

    return report(actor, input);
  });
}
