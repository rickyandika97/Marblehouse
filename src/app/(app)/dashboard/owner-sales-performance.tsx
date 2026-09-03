"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAmount, formatMoney } from "@/lib/money";
import type { OwnerTrendPoint } from "@/server/services/dashboard";

type Period = "today" | "7d" | "30d" | "90d" | "custom";
type Point = OwnerTrendPoint;

const PERIODS: Array<{ key: Exclude<Period, "custom">; label: string; days: number }> = [
  { key: "today", label: "Today", days: 1 },
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
];

/**
 * The owner-only, interactive equivalent of BisMan's Sales Performance card.
 * Its data is server-resolved and role-shaped before it reaches this client
 * component; the client only changes which already-authorized period is drawn.
 */
export function OwnerSalesPerformance({ points }: { points: Point[] }) {
  const [period, setPeriod] = useState<Period>("30d");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const { series, previous } = useMemo(() => {
    if (period === "custom") {
      const filtered = points.filter(
        (point) =>
          (!customFrom || point.businessDate >= customFrom) &&
          (!customTo || point.businessDate <= customTo)
      );
      return { series: filtered, previous: [] as Point[] };
    }
    const days = PERIODS.find((item) => item.key === period)!.days;
    return {
      series: points.slice(-days),
      previous: points.slice(-(days * 2), -days),
    };
  }, [customFrom, customTo, period, points]);

  // Clicking the card title opens the same period in the Daily Sales Summary.
  // The range comes from the drawn series, not from the period key, so a custom
  // range — or a period truncated by how much history exists — lands on exactly
  // the days the chart is showing.
  const reportHref = useMemo(() => {
    const from = series[0]?.businessDate ?? points[0]?.businessDate;
    const to = series.at(-1)?.businessDate ?? points.at(-1)?.businessDate;
    if (!from || !to) return "/reports/sales";
    return `/reports/sales?${new URLSearchParams({ from, to }).toString()}`;
  }, [points, series]);

  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <CardTitle className="text-sm">
              <Link
                href={reportHref}
                className="rounded-sm underline-offset-4 outline-none transition-colors hover:text-emerald-700 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                title="Open the Daily Sales Summary for this period"
              >
                Sales Performance
              </Link>
            </CardTitle>
            <div className="flex items-center gap-4 text-xs text-muted-foreground" aria-label="Chart legend">
              <LegendBar label="Revenue" />
              <LegendLine label="Profit" className="bg-emerald-700" />
              <LegendLine label="Orders" className="bg-blue-600" />
            </div>
          </div>
          <div className="flex items-center rounded-md border bg-muted/50 p-0.5 text-xs">
            {PERIODS.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setPeriod(item.key)}
                className={`rounded px-3 py-1.5 transition-colors ${
                  period === item.key
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {item.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPeriod("custom")}
              className={`rounded px-3 py-1.5 transition-colors ${
                period === "custom"
                  ? "bg-background font-medium text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Custom
            </button>
          </div>
        </div>
        {period === "custom" && (
          <div className="flex flex-wrap items-center gap-2 pt-2 text-xs text-muted-foreground">
            <label>
              <span className="sr-only">From date</span>
              <input
                type="date"
                value={customFrom}
                max={customTo || points.at(-1)?.businessDate}
                onChange={(event) => setCustomFrom(event.target.value)}
                className="rounded border bg-background px-2 py-1.5"
              />
            </label>
            <span>to</span>
            <label>
              <span className="sr-only">To date</span>
              <input
                type="date"
                value={customTo}
                min={customFrom}
                max={points.at(-1)?.businessDate}
                onChange={(event) => setCustomTo(event.target.value)}
                className="rounded border bg-background px-2 py-1.5"
              />
            </label>
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        <PerformanceGraph points={series} />
        <PerformanceKpis series={series} previous={previous} />
      </CardContent>
    </Card>
  );
}

function LegendBar({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <i className="size-2 rounded-sm border bg-stone-200 dark:bg-stone-700" aria-hidden />
      {label}
    </span>
  );
}

function LegendLine({ label, className }: { label: string; className: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <i className={`h-0.5 w-4 rounded ${className}`} aria-hidden />
      {label}
    </span>
  );
}

function PerformanceKpis({ series, previous }: { series: Point[]; previous: Point[] }) {
  const current = totals(series);
  const prior = totals(previous);
  const metrics = [
    { label: "Revenue", value: shortMoney(current.revenue), delta: percentDelta(current.revenue, prior.revenue) },
    { label: "Profit", value: shortMoney(current.profit), delta: percentDelta(current.profit, prior.profit) },
    { label: "Margin", value: `${current.margin.toFixed(1)}%`, delta: percentDelta(current.margin, prior.margin) },
    { label: "Orders", value: formatAmount(current.orders), delta: percentDelta(current.orders, prior.orders) },
    { label: "Avg/Order", value: shortMoney(current.aov), delta: percentDelta(current.aov, prior.aov) },
  ];

  return (
    <div className="mt-4 grid grid-cols-2 border-t pt-4 sm:grid-cols-5">
      {metrics.map((metric, index) => (
        <div key={metric.label} className={`min-w-0 px-3 ${index === 0 ? "pl-0" : "border-l"}`}>
          <p className="text-[10.5px] font-medium uppercase tracking-[0.055em] text-muted-foreground">
            {metric.label}
          </p>
          <p className="mt-1 truncate text-[17px] font-semibold tabular-nums">{metric.value}</p>
          {metric.delta && (
            <p className={`mt-0.5 text-[11px] font-medium ${metric.delta.up ? "text-emerald-700" : "text-red-600"}`}>
              {metric.delta.up ? "↑" : "↓"} {metric.delta.value}% vs prev
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function PerformanceGraph({ points }: { points: Point[] }) {
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observe = () => setWidth(element.getBoundingClientRect().width);
    observe();
    const observer = new ResizeObserver(observe);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The pointer index is resolved from the cursor's x offset rather than from a
  // hover handler per bar: a bar two pixels wide on a 90-day range is not a
  // realistic touch target, so the whole vertical slot for a day is hoverable.
  const track = useCallback(
    (event: React.PointerEvent<SVGSVGElement>, slot: number, left: number, count: number) => {
      const box = event.currentTarget.getBoundingClientRect();
      const index = Math.floor((event.clientX - box.left - left) / slot);
      setActive(index >= 0 && index < count ? index : null);
    },
    []
  );

  if (points.length === 0) {
    return <div className="flex h-[228px] items-center justify-center text-sm text-muted-foreground">No sales data for this period.</div>;
  }

  const svgWidth = Math.max(width, 320);
  const height = 228;
  const pad = { top: 16, right: 56, bottom: 34, left: 58 };
  const chartWidth = svgWidth - pad.left - pad.right;
  const chartHeight = height - pad.top - pad.bottom;
  const baseY = pad.top + chartHeight;
  const slot = chartWidth / points.length;
  const barWidth = Math.min(40, Math.max(4, slot * 0.58));
  const maxRevenue = Math.max(...points.map((point) => Math.abs(Number(point.revenue))), 1) * 1.18;
  const maxOrders = Math.max(...points.map((point) => point.transactions), 1) * 1.25;
  const revenueY = (value: number) => pad.top + chartHeight - (value / maxRevenue) * chartHeight;
  const ordersY = (value: number) => pad.top + chartHeight - (value / maxOrders) * chartHeight;
  const centerX = (index: number) => pad.left + index * slot + slot / 2;
  const labelEvery = points.length <= 7 ? 1 : points.length <= 31 ? 5 : points.length <= 62 ? 10 : 15;
  const today = points.at(-1)?.businessDate;
  const profitPoints = points.map((point, index) => ({ x: centerX(index), y: revenueY(Number(point.grossProfit)) }));
  const orderPoints = points.map((point, index) => ({ x: centerX(index), y: ordersY(point.transactions) }));
  const activePoint = active === null ? null : points[active] ?? null;

  return (
    <div ref={frame} className="relative">
      <svg
        width={svgWidth}
        height={height}
        className="block touch-none overflow-visible"
        role="img"
        aria-label="Revenue, profit, and orders over the selected period"
        onPointerMove={(event) => track(event, slot, pad.left, points.length)}
        onPointerDown={(event) => track(event, slot, pad.left, points.length)}
        onPointerLeave={() => setActive(null)}
        onPointerCancel={() => setActive(null)}
      >
        <defs>
          <linearGradient id="owner-performance-bar" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#eae6de" />
            <stop offset="100%" stopColor="#ddd9d0" />
          </linearGradient>
          <linearGradient id="owner-performance-today" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#3b8a63" />
            <stop offset="100%" stopColor="#2f6f4f" />
          </linearGradient>
          <linearGradient id="owner-performance-hover" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#c9c3b6" />
            <stop offset="100%" stopColor="#b8b1a2" />
          </linearGradient>
          <linearGradient id="owner-performance-profit" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2f6f4f" stopOpacity="0.1" />
            <stop offset="100%" stopColor="#2f6f4f" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="owner-performance-orders" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#2563eb" stopOpacity="0.07" />
            <stop offset="100%" stopColor="#2563eb" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((portion) => {
          const y = revenueY(maxRevenue * portion);
          return <line key={portion} x1={pad.left} y1={y} x2={pad.left + chartWidth} y2={y} stroke="var(--border)" strokeWidth="1" />;
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((portion) => {
          const y = revenueY(maxRevenue * portion);
          return <text key={portion} x={pad.left - 8} y={y} textAnchor="end" dominantBaseline="middle" fontSize="10.5" fill="var(--muted-foreground)">{shortMoney(maxRevenue * portion)}</text>;
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((portion) => {
          const y = ordersY(maxOrders * portion);
          return <text key={portion} x={pad.left + chartWidth + 8} y={y} dominantBaseline="middle" fontSize="10.5" fill="#2563eb" opacity="0.6">{Math.round(maxOrders * portion)}</text>;
        })}
        {active !== null && (
          <line x1={centerX(active)} y1={pad.top} x2={centerX(active)} y2={baseY} stroke="var(--muted-foreground)" strokeWidth="1" strokeDasharray="3 3" opacity="0.45" />
        )}
        <path d={areaPath(profitPoints, baseY)} fill="url(#owner-performance-profit)" />
        <path d={areaPath(orderPoints, baseY)} fill="url(#owner-performance-orders)" />
        {points.map((point, index) => {
          const value = Math.abs(Number(point.revenue));
          const barHeight = Math.max(2, (value / maxRevenue) * chartHeight);
          const x = pad.left + index * slot + (slot - barWidth) / 2;
          const fill =
            index === active
              ? "url(#owner-performance-hover)"
              : point.businessDate === today
                ? "url(#owner-performance-today)"
                : "url(#owner-performance-bar)";
          return <path key={point.businessDate} d={roundedBarPath(x, baseY - barHeight, barWidth, barHeight, 3)} fill={fill} />;
        })}
        <path d={smoothPath(profitPoints)} fill="none" stroke="#2f6f4f" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
        <path d={smoothPath(orderPoints)} fill="none" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="5 3" opacity="0.85" />
        {active !== null && (
          <>
            <circle cx={profitPoints[active]!.x} cy={profitPoints[active]!.y} r="3.5" fill="#2f6f4f" stroke="var(--background)" strokeWidth="1.5" />
            <circle cx={orderPoints[active]!.x} cy={orderPoints[active]!.y} r="3.5" fill="#2563eb" stroke="var(--background)" strokeWidth="1.5" />
          </>
        )}
        {points.map((point, index) => {
          if (index % labelEvery !== 0 && index !== points.length - 1) return null;
          const isToday = point.businessDate === today;
          return <text key={point.businessDate} x={centerX(index)} y={baseY + 13} textAnchor="middle" dominantBaseline="hanging" fontSize="10.5" fill={isToday ? "#2f6f4f" : "var(--muted-foreground)"} fontWeight={isToday ? "600" : undefined}>{dateLabel(point.businessDate)}</text>;
        })}
      </svg>
      {activePoint && <GraphTooltip point={activePoint} x={centerX(active!)} chartWidth={svgWidth} />}
    </div>
  );
}

/**
 * The hover/touch readout for one day.
 *
 * Rendered as HTML rather than inside the SVG so it wraps and inherits the
 * card's type without hand-measuring text. It is `pointer-events-none` so it
 * can never steal the pointer from the bands underneath it — on a touchscreen
 * that would otherwise strand the tooltip on the last day tapped.
 */
function GraphTooltip({ point, x, chartWidth }: { point: Point; x: number; chartWidth: number }) {
  const revenue = Number(point.revenue);
  const profit = Number(point.grossProfit);
  const margin = revenue > 0 ? (profit / revenue) * 100 : 0;
  const rows = [
    { label: "Revenue", value: formatMoney(revenue), tone: "" },
    { label: "Profit", value: formatMoney(profit), tone: "text-emerald-700" },
    { label: "Margin", value: `${margin.toFixed(1)}%`, tone: "" },
    { label: "Orders", value: formatAmount(point.transactions), tone: "text-blue-600" },
    { label: "Avg/order", value: point.transactions > 0 ? formatMoney(revenue / point.transactions) : "—", tone: "" },
  ];

  // Clamped to the frame so a day at either edge stays fully readable.
  const half = 84;
  const left = Math.min(Math.max(x, half), Math.max(chartWidth - half, half));

  return (
    <div
      className="pointer-events-none absolute top-1 z-10 w-[168px] -translate-x-1/2 rounded-md border bg-popover/95 p-2.5 text-popover-foreground shadow-md backdrop-blur-sm"
      style={{ left }}
      role="status"
    >
      <p className="mb-1.5 border-b pb-1.5 text-[11px] font-semibold">{fullDateLabel(point.businessDate)}</p>
      <dl className="space-y-1">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2">
            <dt className="text-[10.5px] text-muted-foreground">{row.label}</dt>
            <dd className={`text-[11.5px] font-medium tabular-nums ${row.tone}`}>{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function totals(points: Point[]) {
  const revenue = points.reduce((total, point) => total + Number(point.revenue), 0);
  const profit = points.reduce((total, point) => total + Number(point.grossProfit), 0);
  const orders = points.reduce((total, point) => total + point.transactions, 0);
  return { revenue, profit, orders, margin: revenue > 0 ? (profit / revenue) * 100 : 0, aov: orders > 0 ? revenue / orders : 0 };
}

function percentDelta(current: number, previous: number) {
  if (!previous) return null;
  const value = Math.abs(((current - previous) / Math.abs(previous)) * 100).toFixed(1);
  return { value, up: current >= previous };
}

function shortMoney(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `Rp ${(value / 1_000_000).toLocaleString("id-ID", { maximumFractionDigits: 1 })}jt`;
  if (Math.abs(value) >= 1_000) return `Rp ${(value / 1_000).toLocaleString("id-ID", { maximumFractionDigits: 1 })}rb`;
  return formatMoney(value);
}

function fullDateLabel(value: string) {
  return new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00.000Z`));
}

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("id-ID", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${value}T00:00:00.000Z`));
}

function roundedBarPath(x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, Math.max(height, 0.01));
  return `M ${x},${y + height} L ${x},${y + r} Q ${x},${y} ${x + r},${y} L ${x + width - r},${y} Q ${x + width},${y} ${x + width},${y + r} L ${x + width},${y + height} Z`;
}

function smoothPath(points: Array<{ x: number; y: number }>, tension = 0.32) {
  if (points.length === 0) return "";
  let path = `M ${points[0]!.x},${points[0]!.y}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index]!;
    const next = points[index + 1]!;
    const dx = (next.x - current.x) * tension;
    path += ` C ${current.x + dx},${current.y} ${next.x - dx},${next.y} ${next.x},${next.y}`;
  }
  return path;
}

function areaPath(points: Array<{ x: number; y: number }>, baseY: number) {
  if (points.length === 0) return "";
  return `${smoothPath(points)} L ${points.at(-1)!.x},${baseY} L ${points[0]!.x},${baseY} Z`;
}
