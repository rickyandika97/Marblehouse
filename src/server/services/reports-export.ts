/**
 * CSV exports for the §9 reports (PRD §7.8).
 *
 * One registry, keyed by report name, so `/api/reports/[name]/export` stays a
 * three-line handler and a new export is a new entry rather than a new route.
 *
 * **The cost rule.** §7.8: "Manager exports have cost columns removed at the
 * query level." Each builder below therefore either calls a cost-gated service
 * — which throws 403 for anyone not entitled, so no CSV is produced at all —
 * or calls a cost-free one and emits cost-free columns. No builder produces a
 * costed row set and then filters headers; that shape is exactly what §15's
 * "no cost value on any endpoint including CSV exports" is guarding against.
 */
import type { Actor } from "@/server/auth/context";
import { AppError } from "@/server/errors";
import { toCsv, type CsvColumn } from "@/server/csv";
import {
  attendanceReport,
  customerReport,
  dailySales,
  expenseReport,
  liabilityReport,
  lowStockReport,
  prizeExpenseReport,
  profitReport,
  salesByShop,
  salesByStaff,
  stockValuation,
  type ReportRangeInput,
} from "./reports";

export interface CsvExport {
  filename: string;
  csv: string;
}

type Builder = (actor: Actor, input: ReportRangeInput) => Promise<CsvExport>;

const cols = <Row,>(c: CsvColumn<Row>[]) => c;

/**
 * Every exportable report. The key is the `:name` in the URL.
 *
 * A name that is not here 404s rather than falling through to something
 * generic — an export endpoint that guesses is an export endpoint that
 * eventually serves the wrong data.
 */
const EXPORTS: Record<string, Builder> = {
  /** Daily Sales Summary (§9). No cost anywhere — every privileged role. */
  sales: async (actor, input) => {
    const { rows, scope } = await dailySales(actor, input);
    return {
      filename: `sales-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Business date", value: (r) => r.businessDate },
          { header: "Revenue", value: (r) => r.revenue },
          { header: "Transactions", value: (r) => r.transactions },
        ])
      ),
    };
  },

  "sales-by-shop": async (actor, input) => {
    const { rows, scope } = await salesByShop(actor, input);
    return {
      filename: `sales-by-shop-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Shop", value: (r) => r.shopName },
          { header: "Revenue", value: (r) => r.revenue },
          { header: "Transactions", value: (r) => r.transactions },
        ])
      ),
    };
  },

  "sales-by-staff": async (actor, input) => {
    const { rows, scope } = await salesByStaff(actor, input);
    return {
      filename: `sales-by-staff-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Staff", value: (r) => r.displayName },
          { header: "Revenue", value: (r) => r.revenue },
          { header: "Transactions", value: (r) => r.transactions },
        ])
      ),
    };
  },

  /**
   * Prize Expense (FIFO). Cost-gated by the SERVICE — a plain manager gets a
   * 403 from `prizeExpenseReport` and never reaches the column list.
   */
  "prize-expense": async (actor, input) => {
    const { byItem, scope } = await prizeExpenseReport(actor, input);
    return {
      filename: `prize-expense-${range(scope)}.csv`,
      csv: toCsv(
        byItem,
        cols([
          { header: "Prize", value: (r) => r.prizeName },
          { header: "Quantity redeemed", value: (r) => r.qty },
          { header: "Prize expense (COGS)", value: (r) => r.expense },
        ])
      ),
    };
  },

  "stock-valuation": async (actor, input) => {
    const { rows, scope } = await stockValuation(actor, input);
    return {
      filename: `stock-valuation-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Shop", value: (r) => r.shopName },
          { header: "Units on hand", value: (r) => r.units },
          { header: "Stock value", value: (r) => r.value },
        ])
      ),
    };
  },

  /** Profit & Loss. Owner-only inside `profitReport`. */
  profit: async (actor, input) => {
    const { rows, scope } = await profitReport(actor, input);
    return {
      filename: `profit-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Shop", value: (r) => r.shopName },
          { header: "Revenue", value: (r) => r.revenue },
          { header: "Prize expense", value: (r) => r.prizeExpense },
          { header: "Shrinkage expense", value: (r) => r.shrinkageExpense },
          { header: "Operating expenses", value: (r) => r.operatingExpenses },
          { header: "Gross profit", value: (r) => r.grossProfit },
          { header: "Net profit", value: (r) => r.netProfit },
        ])
      ),
    };
  },

  expenses: async (actor, input) => {
    const { rows, scope } = await expenseReport(actor, input);
    return {
      filename: `expenses-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Category", value: (r) => r.categoryName },
          { header: "Entries", value: (r) => r.count },
          { header: "Amount", value: (r) => r.amount },
        ])
      ),
    };
  },

  /** Customer Spend Leaderboard. Owner-only inside `customerReport` (§3.4). */
  customers: async (actor, input) => {
    const { rows, scope } = await customerReport(actor, input);
    return {
      filename: `customers-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Customer", value: (r) => r.name },
          { header: "Phone", value: (r) => r.phone },
          { header: "Lifetime value", value: (r) => r.lifetimeValue },
          { header: "Transactions", value: (r) => r.transactions },
          { header: "Active days", value: (r) => r.activeDays },
          { header: "Marble balance", value: (r) => r.marbleBalance },
          { header: "Ticket balance", value: (r) => r.ticketBalance },
        ])
      ),
    };
  },

  attendance: async (actor, input) => {
    const { rows, scope } = await attendanceReport(actor, input);
    return {
      filename: `attendance-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Staff", value: (r) => r.displayName },
          { header: "Records", value: (r) => r.records },
          { header: "Late count", value: (r) => r.lateCount },
          { header: "Late rate", value: (r) => r.lateRate },
          { header: "Total late minutes", value: (r) => r.totalLateMinutes },
          { header: "Average late minutes", value: (r) => r.averageLateMinutes },
        ])
      ),
    };
  },

  "low-stock": async (actor, input) => {
    const { rows, scope } = await lowStockReport(actor, input);
    return {
      filename: `low-stock-${range(scope)}.csv`,
      csv: toCsv(
        rows,
        cols([
          { header: "Shop", value: (r) => r.shopName },
          { header: "Prize", value: (r) => r.prizeName },
          { header: "On hand", value: (r) => r.onHand },
          { header: "Threshold", value: (r) => r.lowStockThreshold },
        ])
      ),
    };
  },

  /**
   * Liability. The VALUED columns exist only for an OWNER — everyone else gets
   * quantities alone, because the valuation is derived from prize expense
   * (§8.4 strips every liability value).
   *
   * **The role test here must be `role === "OWNER"`, matching
   * `liabilityReport` exactly — NOT `canSeeCost`.** A Purchasing manager passes
   * `canSeeCost` but the service still returns null for these two fields, so
   * gating the columns on `canSeeCost` emitted headers over permanently empty
   * cells: an export that promises a figure it can never carry. Found by
   * sweeping every endpoint per role rather than by reading the diff.
   *
   * Two column lists rather than one costed list with entries removed — the
   * removal shape is what leaks (§7.8, "removed at the query level").
   */
  liability: async (actor, input) => {
    const report = await liabilityReport(actor, input);
    const rows = [report];
    const quantityColumns = cols<typeof report>([
      { header: "Outstanding marbles", value: (r) => r.outstandingMarbles },
      { header: "Outstanding tickets", value: (r) => r.outstandingTickets },
      { header: "Tickets awarded", value: (r) => r.ticketsAwarded },
      { header: "Tickets redeemed", value: (r) => r.ticketsRedeemed },
    ]);

    return {
      filename: `liability-${range(report.scope)}.csv`,
      csv: toCsv(
        rows,
        actor.role === "OWNER"
          ? [
              ...quantityColumns,
              {
                header: "Blended COGS per ticket",
                value: (r) => r.blendedCogsPerTicket,
              },
              {
                header: "Estimated ticket liability",
                value: (r) => r.estimatedTicketLiability,
              },
            ]
          : quantityColumns
      ),
    };
  },
};

export const EXPORT_NAMES = Object.keys(EXPORTS);

export async function buildExport(
  name: string,
  actor: Actor,
  input: ReportRangeInput
): Promise<CsvExport> {
  const builder = EXPORTS[name];
  if (!builder) {
    throw new AppError("NOT_FOUND", `There is no report called "${name}".`, {
      available: EXPORT_NAMES,
    });
  }
  return builder(actor, input);
}

function range(scope: { from: Date; to: Date }): string {
  return `${scope.from.toISOString().slice(0, 10)}_${scope.to
    .toISOString()
    .slice(0, 10)}`;
}
