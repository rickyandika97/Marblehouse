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
  profitReport,
  reportRangeSchema,
  salesByShop,
  salesByStaff,
  salesSummary,
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
  customers: customerReport,
  "prize-expense": prizeExpenseReport,
  "stock-valuation": stockValuation,
  liability: liabilityReport,
  profit: profitReport,
  attendance: attendanceReport,
  "low-stock": lowStockReport,
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
    const input = reportRangeSchema.parse({
      shopId: searchParams.get("shopId") ?? undefined,
      from: searchParams.get("from") ?? undefined,
      to: searchParams.get("to") ?? undefined,
    });

    return report(actor, input);
  });
}
