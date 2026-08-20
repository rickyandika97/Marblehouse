import Link from "next/link";
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
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

      {/* ── Row 1: today ── */}
      <section aria-label="Today" className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Revenue" value={formatMoney(dashboard.today.revenue)} icon={CircleDollarSign} />
        <Stat label="Sales" value={formatAmount(dashboard.today.transactions)} />
        <Stat label="Customers" value={formatAmount(dashboard.today.uniqueCustomers)} icon={Users} />
        <Stat label="Tickets awarded" value={formatAmount(dashboard.today.ticketsAwarded)} icon={Ticket} />
        <Stat label="Prizes redeemed" value={formatAmount(dashboard.today.prizesRedeemed)} icon={Package} />
      </section>

      {/* ── Row 2: the period (owner only — it carries gross profit) ── */}
      {isOwner && (
        <section aria-label="This month" className="grid gap-3 md:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Month to date
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums">
                {formatMoney(dashboard.monthToDate.revenue)}
              </p>
              <Delta percent={dashboard.monthToDate.deltaPercent} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Last month
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums">
                {formatMoney(dashboard.monthToDate.previousMonthRevenue)}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                Gross profit (MTD)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums">
                {formatMoney(dashboard.monthToDate.grossProfit)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Revenue − prize expense − shrinkage
              </p>
            </CardContent>
          </Card>
        </section>
      )}

      {/* ── Row 3: breakdown ── */}
      <section className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Last 30 days</CardTitle>
          </CardHeader>
          <CardContent>
            <Sparkline points={dashboard.trend30d} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">
              {isOwner ? "Revenue by shop" : "Payment method, today"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isOwner ? (
              <ShopBars rows={dashboard.revenueByShop} />
            ) : (
              <PaymentSplit split={dashboard.paymentSplit} />
            )}
          </CardContent>
        </Card>
      </section>

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

function Delta({ percent }: { percent: string | null }) {
  // Null means there is no prior month to compare against. A "0%" or "+100%"
  // would both be inventions.
  if (percent === null) {
    return <p className="mt-1 text-xs text-muted-foreground">No prior month to compare</p>;
  }
  const n = Number(percent);
  const up = n >= 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <p
      className={cn(
        "mt-1 flex items-center gap-1 text-xs font-medium",
        up ? "text-emerald-600" : "text-red-600"
      )}
    >
      <Icon className="size-3.5" />
      {up ? "+" : ""}
      {percent}% vs last month
    </p>
  );
}

/**
 * A dependency-free sparkline.
 *
 * Recharts is in the stack (§5.2) and is the right tool for the report screens,
 * but this is a 30-point trend inside a server component — an inline SVG keeps
 * the dashboard fully server-rendered with no client bundle at all.
 */
function Sparkline({ points }: { points: { businessDate: string; revenue: string }[] }) {
  if (points.length === 0) {
    return <p className="text-sm text-muted-foreground">No sales in this period yet.</p>;
  }

  const values = points.map((p) => Number(p.revenue));
  const max = Math.max(...values, 1);
  const w = 100;
  const h = 28;
  const step = points.length > 1 ? w / (points.length - 1) : w;
  const path = values
    .map((v, i) => `${i === 0 ? "M" : "L"} ${(i * step).toFixed(2)} ${(h - (v / max) * h).toFixed(2)}`)
    .join(" ");
  const total = values.reduce((a, b) => a + b, 0);

  return (
    <div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        role="img"
        aria-label={`Revenue over the last ${points.length} days`}
      >
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <p className="mt-2 text-sm text-muted-foreground">
        {formatMoney(total)} over {points.length} days
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
