/**
 * Dashboard payloads (PRD §8.3 owner, §8.4 manager).
 *
 * Separate from `reports.ts` because it answers a different question. A report
 * is "one metric, sliced" — the dashboard is "everything I need at 9am, in one
 * round trip". It composes the engine rather than duplicating it: every money
 * figure below comes from a `reports.ts` function, so a fix to a definition
 * lands on the dashboard and the report together.
 *
 * **The role difference is structural, not cosmetic.** §8.4 gives a manager the
 * same layout "minus every cost, profit and liability-value figure". That is
 * expressed here as two builders returning two different TYPES — a manager's
 * payload has no cost keys to strip, because they were never read (§7.5, the
 * pattern from `dto/prize.ts`). Do not merge these into one function with
 * optional fields; a nullable cost key is one careless spread away from a leak.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/server/auth/context";
import { forbidden } from "@/server/errors";
import {
  addDays,
  attendanceReport,
  dailySales,
  isoDate,
  liabilityReport,
  lowStockRowsForScope,
  profitReport,
  resolveScope,
  salesByShop,
  salesSummary,
  stockValuation,
  type ReportRangeInput,
  type ResolvedScope,
} from "./reports";

/** §5.6: charts become unreadable past ~8 series, so the rest is an "Others" bucket. */
const CHART_SHOP_LIMIT = 8;

/** §8.3: last backup age turns red past this. */
const BACKUP_STALE_HOURS = 36;

/** §8.3: transfers in transit older than this are an alert. */
const IN_TRANSIT_ALERT_DAYS = 3;

// ───────────────────────────── SHARED SHAPES ─────────────────────────────

export interface TodayRow {
  revenue: string;
  transactions: number;
  uniqueCustomers: number;
  ticketsAwarded: number;
  prizesRedeemed: number;
}

export interface TrendPoint {
  businessDate: string;
  revenue: string;
  transactions: number;
}

export interface ShopRevenueSlice {
  shopId: string;
  shopName: string;
  revenue: string;
}

export interface AlertsPanel {
  lowStockCount: number;
  notClockedIn: { shopId: string; shopName: string; count: number }[];
  lateToday: number;
  staleTransfers: number;
  balanceDrift: { key: string; title: string; message: string }[];
}

/** Owner-only additions to the alerts panel — each is a cost or admin concern. */
export interface OwnerAlertsPanel extends AlertsPanel {
  uncostedBatchCount: number;
  lastBackupAt: string | null;
  backupAgeHours: number | null;
  backupIsStale: boolean;
}

export interface ManagerDashboard {
  role: "MANAGER";
  shopId: string;
  shopName: string;
  today: TodayRow;
  trend30d: TrendPoint[];
  paymentSplit: { cash: string; edc: string };
  alerts: AlertsPanel;
  /** Quantities only — §8.4 strips every liability VALUE. */
  liability: { outstandingMarbles: number; outstandingTickets: number };
  team: { records: number; lateCount: number; lateRate: string };
}

export interface OwnerDashboard {
  role: "OWNER";
  isAllShops: boolean;
  today: TodayRow;
  trend30d: TrendPoint[];
  paymentSplit: { cash: string; edc: string };
  revenueByShop: ShopRevenueSlice[];
  monthToDate: {
    revenue: string;
    previousMonthRevenue: string;
    deltaPercent: string | null;
    grossProfit: string;
  };
  alerts: OwnerAlertsPanel;
  liability: {
    outstandingMarbles: number;
    outstandingTickets: number;
    estimatedTicketLiability: string | null;
    stockValuation: string;
  };
  team: { records: number; lateCount: number; lateRate: string };
}

export type Dashboard = OwnerDashboard | ManagerDashboard;

// ───────────────────────────── ENTRY POINT ─────────────────────────────

export async function getDashboard(
  actor: Actor,
  input: ReportRangeInput
): Promise<Dashboard> {
  if (actor.role === "STAFF") {
    // §3.4: staff see no money reporting beyond their own shift's sale list.
    throw forbidden("The dashboard is not available to staff accounts.");
  }
  return actor.role === "OWNER"
    ? ownerDashboard(actor, input)
    : managerDashboard(actor, input);
}

// ───────────────────────────── OWNER ─────────────────────────────

async function ownerDashboard(
  actor: Actor,
  input: ReportRangeInput
): Promise<OwnerDashboard> {
  const today = isoDate(actor.businessDate);
  const scope = await resolveScope(actor, input);
  const todayInput: ReportRangeInput = { ...input, from: today, to: today };

  const [
    todayRow,
    trend,
    todaySummaryRow,
    byShop,
    mtd,
    alerts,
    liability,
    valuation,
    team,
  ] = await Promise.all([
    todayFigures(actor, todayInput, scope),
    trend30d(actor, input, actor.businessDate),
    salesSummary(actor, todayInput),
    salesByShop(actor, input),
    monthToDate(actor, actor.businessDate),
    ownerAlerts(actor, scope),
    liabilityReport(actor, input),
    stockValuation(actor, input),
    attendanceReport(actor, input),
  ]);

  return {
    role: "OWNER",
    isAllShops: scope.isAllShops,
    today: todayRow,
    trend30d: trend,
    paymentSplit: { cash: todaySummaryRow.cash, edc: todaySummaryRow.edc },
    revenueByShop: topShopsWithOthers(byShop.rows),
    monthToDate: mtd,
    alerts,
    liability: {
      outstandingMarbles: liability.outstandingMarbles,
      outstandingTickets: liability.outstandingTickets,
      estimatedTicketLiability: liability.estimatedTicketLiability,
      stockValuation: valuation.total,
    },
    team: team.totals,
  };
}

/**
 * §5.6: "the revenue-by-shop chart shows the top 8 by revenue plus an Others
 * bucket". Enforced here rather than in the component, so every consumer of
 * this payload — chart, CSV, a future mobile view — gets the same shape and
 * nobody re-introduces a 30-series chart.
 */
function topShopsWithOthers(rows: ShopRevenueSlice[]): ShopRevenueSlice[] {
  if (rows.length <= CHART_SHOP_LIMIT) return rows;
  const top = rows.slice(0, CHART_SHOP_LIMIT);
  const rest = rows.slice(CHART_SHOP_LIMIT);
  const othersTotal = rest.reduce(
    (sum, r) => sum.add(r.revenue),
    new Prisma.Decimal(0)
  );
  return [
    ...top,
    { shopId: "OTHERS", shopName: `Others (${rest.length})`, revenue: othersTotal.toString() },
  ];
}

/** §8.3 row 2: this month vs last month, with a % delta, plus MTD gross profit. */
async function monthToDate(
  actor: Actor,
  businessDate: Date
): Promise<OwnerDashboard["monthToDate"]> {
  const d = new Date(businessDate);
  const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const prevMonthStart = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)
  );
  const prevMonthEnd = addDays(monthStart, -1);

  const [current, previous, profit] = await Promise.all([
    salesSummary(actor, { from: isoDate(monthStart), to: isoDate(businessDate) }),
    salesSummary(actor, {
      from: isoDate(prevMonthStart),
      to: isoDate(prevMonthEnd),
    }),
    profitReport(actor, {
      from: isoDate(monthStart),
      to: isoDate(businessDate),
    }),
  ]);

  const currentRevenue = new Prisma.Decimal(current.revenue);
  const previousRevenue = new Prisma.Decimal(previous.revenue);

  return {
    revenue: current.revenue,
    previousMonthRevenue: previous.revenue,
    // Null rather than a fake 100% when there is no prior month to compare
    // against — a percentage off a zero base is not information.
    deltaPercent: previousRevenue.gt(0)
      ? currentRevenue
          .sub(previousRevenue)
          .div(previousRevenue)
          .mul(100)
          .toDecimalPlaces(1)
          .toString()
      : null,
    grossProfit: profit.combined.grossProfit,
  };
}

async function ownerAlerts(
  actor: Actor,
  scope: ResolvedScope
): Promise<OwnerAlertsPanel> {
  const [base, uncosted, backup] = await Promise.all([
    sharedAlerts(actor, scope),
    prisma.prizeBatch.count({
      where: { shopId: { in: scope.shopIds }, needsCosting: true, isVoid: false },
    }),
    prisma.backupRun.findFirst({
      where: { succeeded: true },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true },
    }),
  ]);

  const ageHours = backup
    ? (Date.now() - backup.startedAt.getTime()) / 3_600_000
    : null;

  return {
    ...base,
    uncostedBatchCount: uncosted,
    lastBackupAt: backup?.startedAt.toISOString() ?? null,
    backupAgeHours: ageHours === null ? null : Math.floor(ageHours),
    // No backup at all is stale by definition — the panel must not read as
    // healthy on a system that has never backed up (§8.3, §13.4).
    backupIsStale: ageHours === null || ageHours > BACKUP_STALE_HOURS,
  };
}

// ───────────────────────────── MANAGER ─────────────────────────────

async function managerDashboard(
  actor: Actor,
  input: ReportRangeInput
): Promise<ManagerDashboard> {
  // §3.4: a manager views one shop at a time. `resolveScope` already collapses
  // an unscoped manager request to their work-session shop (the 8 Aug decision),
  // so this is always exactly one shop.
  const scope = await resolveScope(actor, input);
  const shopId = scope.shopIds[0]!;
  const today = isoDate(actor.businessDate);
  const todayInput: ReportRangeInput = { shopId, from: today, to: today };

  const [shop, todayRow, trend, todaySummaryRow, alerts, liability, team] =
    await Promise.all([
      prisma.shop.findUnique({
        where: { id: shopId },
        select: { id: true, name: true },
      }),
      todayFigures(actor, todayInput, scope),
      trend30d(actor, { ...input, shopId }, actor.businessDate),
      salesSummary(actor, todayInput),
      sharedAlerts(actor, scope),
      liabilityReport(actor, { ...input, shopId }),
      attendanceReport(actor, { ...input, shopId }),
    ]);

  return {
    role: "MANAGER",
    shopId,
    shopName: shop?.name ?? "Unknown shop",
    today: todayRow,
    trend30d: trend,
    paymentSplit: { cash: todaySummaryRow.cash, edc: todaySummaryRow.edc },
    alerts,
    // Quantities only. `liabilityReport` already returns null for the valued
    // fields to a non-owner; not spreading them here is the second line of
    // defence, so a change to that function cannot leak a value into this DTO.
    liability: {
      outstandingMarbles: liability.outstandingMarbles,
      outstandingTickets: liability.outstandingTickets,
    },
    team: team.totals,
  };
}

// ───────────────────────────── SHARED PIECES ─────────────────────────────

/** §8.3 row 1 / §8.4: today's headline figures. No cost anywhere. */
async function todayFigures(
  actor: Actor,
  todayInput: ReportRangeInput,
  scope: ResolvedScope
): Promise<TodayRow> {
  const businessDate = actor.businessDate;
  const [summary, tickets, redeemed] = await Promise.all([
    salesSummary(actor, todayInput),
    prisma.ticketLedger.aggregate({
      where: { type: "AWARD", shopId: { in: scope.shopIds }, businessDate },
      _sum: { delta: true },
    }),
    prisma.redemptionLine.aggregate({
      where: {
        redemption: {
          shopId: { in: scope.shopIds },
          businessDate,
          isVoided: false,
        },
      },
      _sum: { qty: true },
    }),
  ]);

  return {
    revenue: summary.revenue,
    transactions: summary.transactions,
    uniqueCustomers: summary.uniqueCustomers,
    ticketsAwarded: tickets._sum.delta ?? 0,
    prizesRedeemed: redeemed._sum.qty ?? 0,
  };
}

async function trend30d(
  actor: Actor,
  input: ReportRangeInput,
  businessDate: Date
): Promise<TrendPoint[]> {
  const { rows } = await dailySales(actor, {
    ...input,
    from: isoDate(addDays(businessDate, -29)),
    to: isoDate(businessDate),
  });
  return rows;
}

/**
 * The alerts every privileged role sees (§8.3 row 4, §8.4).
 *
 * Nothing here is a cost figure — these are counts and names — so a plain
 * manager may read the whole panel for their own shop.
 */
async function sharedAlerts(
  actor: Actor,
  scope: ResolvedScope
): Promise<AlertsPanel> {
  const businessDate = actor.businessDate;

  const [lowStock, shops, clockedIn, assignments, lateToday, stale, drift] =
    await Promise.all([
      // Takes the resolved scope directly — see lowStockRowsForScope. Passing
      // a re-derived shopId here would silently narrow an owner's all-shops
      // panel to one branch.
      lowStockRowsForScope(scope),
      prisma.shop.findMany({
        where: { id: { in: scope.shopIds }, isActive: true, isHqPseudoShop: false },
        select: { id: true, name: true },
      }),
      prisma.attendance.findMany({
        where: { shopId: { in: scope.shopIds }, businessDate },
        select: { userId: true, shopId: true },
      }),
      prisma.userShop.findMany({
        where: { shopId: { in: scope.shopIds }, user: { banned: false } },
        select: { userId: true, shopId: true },
      }),
      prisma.attendance.count({
        where: { shopId: { in: scope.shopIds }, businessDate, isLate: true },
      }),
      prisma.prizeTransfer.count({
        where: {
          status: "IN_TRANSIT",
          fromShopId: { in: scope.shopIds },
          dispatchedAt: { lt: addDays(new Date(), -IN_TRANSIT_ALERT_DAYS) },
        },
      }),
      prisma.systemAlert.findMany({
        where: { isActive: true, severity: "CRITICAL" },
        orderBy: { lastSeenAt: "desc" },
        take: 10,
        select: { key: true, title: true, message: true },
      }),
    ]);

  // "Staff not yet clocked in today, per shop" — assigned minus present.
  const clockedInKeys = new Set(clockedIn.map((a) => `${a.shopId}:${a.userId}`));
  const notClockedInByShop = new Map<string, number>();
  for (const a of assignments) {
    if (!clockedInKeys.has(`${a.shopId}:${a.userId}`)) {
      notClockedInByShop.set(a.shopId, (notClockedInByShop.get(a.shopId) ?? 0) + 1);
    }
  }

  return {
    lowStockCount: lowStock.length,
    notClockedIn: shops
      .map((s) => ({
        shopId: s.id,
        shopName: s.name,
        count: notClockedInByShop.get(s.id) ?? 0,
      }))
      .filter((s) => s.count > 0),
    lateToday,
    staleTransfers: stale,
    balanceDrift: drift,
  };
}
