import Link from "next/link";
import {
  AlertTriangle,
  CircleDollarSign,
  Clock,
  Package,
  Ticket,
  Users,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAmount, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";
import type { Dashboard } from "@/server/services/dashboard";
import { DashboardShopPicker } from "./shop-picker";
import { OwnerSalesPerformance } from "./owner-sales-performance";

/**
 * Dashboard presentation (§8.3, §8.4).
 *
 * Purely presentational and role-driven by the payload's discriminant, not by
 * a permission check of its own: an owner payload carries the cost and
 * liability figures, a manager payload structurally does not have them. This
 * component never decides who may see what — that was decided server-side
 * before the data reached it (§7.5).
 */
export function DashboardView({
  dashboard,
  shops = [],
  shopId,
}: {
  dashboard: Dashboard;
  shops?: { id: string; name: string }[];
  shopId?: string;
}) {
  const isOwner = dashboard.role === "OWNER";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isOwner
              ? dashboard.isAllShops
                ? "All shops, today."
                : "One shop, today."
              : `${dashboard.shopName}, today.`}
          </p>
        </div>
        {isOwner && <DashboardShopPicker shopId={shopId} shops={shops} />}
      </div>

      {dashboard.role === "OWNER" ? (
        <OwnerSalesOverview dashboard={dashboard} />
      ) : (
        <ManagerSalesOverview dashboard={dashboard} />
      )}

      {/* ── Row 4: alerts — §8.3 calls this the most valuable panel ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Needs attention</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Alert
            show={dashboard.alerts.lowStockCount > 0}
            tone="warn"
            href="/stock"
            text={`${dashboard.alerts.lowStockCount} prize${
              dashboard.alerts.lowStockCount === 1 ? " is" : "s are"
            } at or below the low-stock threshold`}
          />
          {dashboard.alerts.notClockedIn.map((s) => (
            <Alert
              key={s.shopId}
              show
              tone="warn"
              href="/attendance?view=report"
              text={`${s.count} not clocked in at ${s.shopName}`}
            />
          ))}
          <Alert
            show={dashboard.alerts.lateToday > 0}
            tone="warn"
            href="/attendance?view=report"
            text={`${dashboard.alerts.lateToday} arrived late today`}
          />
          <Alert
            show={dashboard.alerts.staleTransfers > 0}
            tone="warn"
            href="/stock"
            text={`${dashboard.alerts.staleTransfers} transfer${
              dashboard.alerts.staleTransfers === 1 ? "" : "s"
            } in transit for more than 3 days`}
          />
          {dashboard.alerts.balanceDrift.map((a) => (
            <Alert key={a.key} show tone="critical" text={a.message} />
          ))}

          {isOwner && (
            <>
              <Alert
                show={dashboard.alerts.uncostedBatchCount > 0}
                tone="warn"
                href="/stock/uncosted"
                text={`${dashboard.alerts.uncostedBatchCount} batch${
                  dashboard.alerts.uncostedBatchCount === 1 ? "" : "es"
                } awaiting a cost`}
              />
              {/* A system that has never backed up is stale by definition —
                  this must not read as healthy (§13.4). */}
              <Alert
                show={dashboard.alerts.backupIsStale}
                tone="critical"
                text={
                  dashboard.alerts.lastBackupAt === null
                    ? "No backup has ever run"
                    : `Last backup was ${dashboard.alerts.backupAgeHours} hours ago`
                }
              />
            </>
          )}

          <NothingWrong dashboard={dashboard} />
        </CardContent>
      </Card>

      {/* ── Row 5: liability ── */}
      <section aria-label="Liability" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Outstanding marbles"
          value={formatAmount(dashboard.liability.outstandingMarbles)}
          hint="Held for customers"
        />
        <Stat
          label="Outstanding tickets"
          value={formatAmount(dashboard.liability.outstandingTickets)}
          hint="Redeemable at any branch"
        />
        {/* These two exist only on an owner payload — §8.4 strips every
            liability VALUE from a manager's view. */}
        {isOwner && (
          <>
            <Stat
              label="Est. ticket liability"
              value={
                dashboard.liability.estimatedTicketLiability === null
                  ? "—"
                  : formatMoney(dashboard.liability.estimatedTicketLiability)
              }
              hint="Memo line, not booked"
            />
            <Stat
              label="Stock value on hand"
              value={formatMoney(dashboard.liability.stockValuation)}
            />
          </>
        )}
      </section>

      <section aria-label="Team">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Attendance, last 30 days</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-6 text-sm">
            <Figure label="Records" value={formatAmount(dashboard.team.records)} />
            <Figure label="Late" value={formatAmount(dashboard.team.lateCount)} />
            <Figure
              label="Late rate"
              value={`${(Number(dashboard.team.lateRate) * 100).toFixed(1)}%`}
            />
            <Link
              href="/attendance?view=report"
              className="ml-auto self-center text-sm underline underline-offset-4"
            >
              Attendance report
            </Link>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

/**
 * The owner sees cost-bearing profit figures and the month-to-date roll-up.
 * Keeping this in an owner-only component makes a cost-field reference a type
 * error everywhere in the manager branch, not merely a hidden card.
 */
function OwnerSalesOverview({
  dashboard,
}: {
  dashboard: Extract<Dashboard, { role: "OWNER" }>;
}) {
  return (
    <>
      <section
        aria-label="Today’s sales"
        className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6"
      >
        <Stat
          label="Revenue today"
          value={formatMoney(dashboard.today.revenue)}
          icon={CircleDollarSign}
        />
        <Stat label="Profit today" value={formatMoney(dashboard.today.grossProfit)} />
        <Stat label="Average order" value={formatMoney(dashboard.today.averageOrderValue)} />
        <Stat label="Orders today" value={formatAmount(dashboard.today.transactions)} />
        <Stat
          label="Tickets awarded"
          value={formatAmount(dashboard.today.ticketsAwarded)}
          icon={Ticket}
        />
        <Stat
          label="Prizes redeemed"
          value={formatAmount(dashboard.today.prizesRedeemed)}
          icon={Package}
        />
      </section>

      <section className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(17rem,1fr)]">
        <OwnerSalesPerformance points={dashboard.trend180d} />

        <Card>
          <CardHeader className="border-b pb-3">
            <CardTitle>Revenue by shop</CardTitle>
            <p className="text-xs text-muted-foreground">Month to date</p>
          </CardHeader>
          <CardContent className="pt-4">
            <ShopBars rows={dashboard.revenueByShop} />
          </CardContent>
        </Card>
      </section>
    </>
  );
}

/** Managers keep the existing, non-cost-bearing data set. */
function ManagerSalesOverview({
  dashboard,
}: {
  dashboard: Extract<Dashboard, { role: "MANAGER" }>;
}) {
  return (
    <>
      <section aria-label="Today" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Revenue today" value={formatMoney(dashboard.today.revenue)} icon={CircleDollarSign} />
        <Stat label="Orders today" value={formatAmount(dashboard.today.transactions)} />
        <Stat label="Customers" value={formatAmount(dashboard.today.uniqueCustomers)} icon={Users} />
        <Stat label="Tickets awarded" value={formatAmount(dashboard.today.ticketsAwarded)} icon={Ticket} />
        <Stat label="Prizes redeemed" value={formatAmount(dashboard.today.prizesRedeemed)} icon={Package} />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="border-b pb-3">
            <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
              <CardTitle>Sales performance</CardTitle>
              <ChartLegend />
            </div>
            <p className="text-xs text-muted-foreground">Last 30 days</p>
          </CardHeader>
          <CardContent className="pt-4">
            <SalesPerformanceChart points={dashboard.trend30d} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b pb-3">
            <CardTitle>Payment method, today</CardTitle>
          </CardHeader>
          <CardContent className="pt-4">
            <PaymentSplit split={dashboard.paymentSplit} />
          </CardContent>
        </Card>
      </section>
    </>
  );
}

// ─────────────────────────── pieces ───────────────────────────

function Stat({
  label,
  value,
  hint,
  icon: Icon,
}: {
  label: string;
  value: string;
  hint?: string;
  icon?: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          {Icon && <Icon className="size-3.5" />}
          {label}
        </div>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ChartLegend() {
  return (
    <div className="flex items-center gap-4 text-xs text-muted-foreground" aria-label="Chart legend">
      <span className="flex items-center gap-1.5">
        <i className="size-2 rounded-sm bg-stone-300" aria-hidden />
        Revenue
      </span>
      <span className="flex items-center gap-1.5">
        <i className="h-0.5 w-3 rounded bg-blue-500" aria-hidden />
        Orders
      </span>
    </div>
  );
}

/**
 * A server-rendered revenue-and-orders chart. Unlike the old sparkline, it
 * keeps zero-sale days visible, provides axes and a legend, and gives revenue
 * and order volume their own scales — the compact visual hierarchy used by the
 * sales-performance reference without adding a client-side chart library.
 */
function SalesPerformanceChart({
  points,
}: {
  points: { businessDate: string; revenue: string; transactions: number }[];
}) {
  if (points.length === 0) {
    return <p className="text-sm text-muted-foreground">No sales in this period yet.</p>;
  }

  const revenues = points.map((p) => Number(p.revenue));
  const orders = points.map((p) => p.transactions);
  const total = revenues.reduce((sum, value) => sum + value, 0);
  const maxRevenue = Math.max(...revenues, 1);
  const maxOrders = Math.max(...orders, 1);
  const left = 8;
  const right = 96;
  const top = 5;
  const bottom = 39;
  const width = right - left;
  const height = bottom - top;
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const barWidth = Math.min(step * 0.58, 2.2);
  const orderPath = orders
    .map((value, index) => {
      const x = left + index * step;
      const y = bottom - (value / maxOrders) * height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
  const dateLabel = (index: number) =>
    new Intl.DateTimeFormat("id-ID", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${points[index]!.businessDate}T00:00:00.000Z`));

  return (
    <div>
      <svg
        viewBox="0 0 100 48"
        preserveAspectRatio="none"
        className="h-52 w-full"
        role="img"
        aria-label={`Revenue and orders over the last ${points.length} days`}
      >
        {[top, top + height / 3, top + (height * 2) / 3, bottom].map((y) => (
          <line
            key={y}
            x1={left}
            x2={right}
            y1={y}
            y2={y}
            className="stroke-border"
            strokeWidth="0.25"
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {revenues.map((value, index) => {
          const barHeight = (value / maxRevenue) * height;
          const x = left + index * step - barWidth / 2;
          return (
            <rect
              key={points[index]!.businessDate}
              x={x}
              y={bottom - barHeight}
              width={barWidth}
              height={barHeight}
              rx="0.35"
              className="fill-stone-300 dark:fill-stone-700"
            />
          );
        })}
        <path
          d={orderPath}
          fill="none"
          className="stroke-blue-500"
          strokeWidth="1.25"
          strokeDasharray="2 1.3"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="-mt-2 flex justify-between pl-[8%] pr-[4%] text-[11px] text-muted-foreground">
        <span>{dateLabel(0)}</span>
        <span>{dateLabel(Math.floor((points.length - 1) / 2))}</span>
        <span>{dateLabel(points.length - 1)}</span>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {formatMoney(total)} across {formatAmount(orders.reduce((sum, value) => sum + value, 0))} orders
      </p>
    </div>
  );
}

function ShopBars({ rows }: { rows: { shopId: string; shopName: string; revenue: string }[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No sales in this period yet.</p>;
  }
  const max = Math.max(...rows.map((r) => Number(r.revenue)), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.shopId}>
          <div className="flex justify-between text-sm">
            <span className="truncate">{r.shopName}</span>
            <span className="ml-2 shrink-0 tabular-nums">{formatMoney(r.revenue)}</span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded bg-muted">
            <div
              className="h-1.5 rounded bg-foreground/70"
              style={{ width: `${Math.max((Number(r.revenue) / max) * 100, 1)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function PaymentSplit({ split }: { split: { cash: string; edc: string } }) {
  const cash = Number(split.cash);
  const edc = Number(split.edc);
  const total = cash + edc;
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">No sales today yet.</p>;
  }
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span>Cash</span>
        <span className="tabular-nums">{formatMoney(split.cash)}</span>
      </div>
      <div className="flex h-2 overflow-hidden rounded bg-muted">
        <div className="bg-foreground/70" style={{ width: `${(cash / total) * 100}%` }} />
      </div>
      <div className="flex justify-between text-sm">
        <span>EDC</span>
        <span className="tabular-nums">{formatMoney(split.edc)}</span>
      </div>
    </div>
  );
}

function Alert({
  show,
  tone,
  text,
  href,
}: {
  show: boolean;
  tone: "warn" | "critical";
  text: string;
  href?: string;
}) {
  if (!show) return null;
  const body = (
    <div
      className={cn(
        "flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm",
        tone === "critical"
          ? "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200"
          : "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      )}
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span>{text}</span>
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Says so explicitly when there is nothing wrong — an empty panel is ambiguous. */
function NothingWrong({ dashboard }: { dashboard: Dashboard }) {
  const a = dashboard.alerts;
  const shared =
    a.lowStockCount > 0 ||
    a.notClockedIn.length > 0 ||
    a.lateToday > 0 ||
    a.staleTransfers > 0 ||
    a.balanceDrift.length > 0;

  // Narrowed on `dashboard`, not on the destructured alerts: the owner-only
  // fields live on OwnerAlertsPanel and TypeScript is right to refuse them on
  // the shared type. That refusal is the cost boundary doing its job.
  const ownerOnly =
    dashboard.role === "OWNER" &&
    (dashboard.alerts.uncostedBatchCount > 0 || dashboard.alerts.backupIsStale);

  if (shared || ownerOnly) return null;
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Clock className="size-4" />
      Nothing needs attention right now.
    </p>
  );
}
