"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatAmount, formatMoney } from "@/lib/money";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import type { TrendPoint } from "@/server/services/dashboard";

/**
 * The manager's sales chart, with the same period switcher the owner's cards
 * have (D-183).
 *
 * **Revenue and orders only — never profit.** The points arriving here are
 * `TrendPoint`, which has no `grossProfit` field to render even by accident;
 * §8.4 withholds profit from a manager. Do not "unify" this with
 * `OwnerSalesPerformance`, whose whole reason for existing is the cost-bearing
 * third series.
 *
 * The tab set matches the revenue-by-shop card, including "This month" in
 * place of a rolling 30 days (D-182).
 */
type Period = "today" | "7d" | "month" | "90d" | "custom";

const PERIODS: Array<{ key: Exclude<Period, "custom">; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "month", label: "This month" },
  { key: "90d", label: "90 days" },
];

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthStartIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function windowFor(period: Period, today: string): { from: string; to: string } {
  switch (period) {
    case "today":
      return { from: today, to: today };
    case "7d":
      return { from: shiftIso(today, -6), to: today };
    case "month":
      return { from: monthStartIso(today), to: today };
    case "90d":
      return { from: shiftIso(today, -89), to: today };
    case "custom":
      return { from: today, to: today };
  }
}

/** "1 Sep 2026" — matches the range button rather than showing raw ISO. */
function formatDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function periodLabel(period: Period, from: string, to: string): string {
  switch (period) {
    case "today":
      return "Today";
    case "7d":
      return "Last 7 days";
    case "month":
      return "Month to date";
    case "90d":
      return "Last 90 days";
    case "custom":
      if (!from || !to) return "Pick a date range";
      return from === to ? formatDay(from) : `${formatDay(from)} – ${formatDay(to)}`;
  }
}

export function ManagerSalesPerformance({ points }: { points: TrendPoint[] }) {
  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  // The server's business date, never `new Date()` — the browser can sit in
  // another timezone and shift a day's takings.
  const businessDate = points.at(-1)?.businessDate ?? "";

  const { from, to } =
    period === "custom"
      ? { from: customFrom, to: customTo }
      : windowFor(period, businessDate);

  const series = useMemo(() => {
    if (period === "custom" && (!from || !to)) return [];
    return points.filter((p) => p.businessDate >= from && p.businessDate <= to);
  }, [points, from, to, period]);

  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
          <CardTitle>Sales performance</CardTitle>
          <ChartLegend />
        </div>
        <p className="text-xs text-muted-foreground">
          {periodLabel(period, customFrom, customTo)}
        </p>
        <div className="mt-2 flex items-center rounded-md border bg-muted/50 p-0.5 text-xs">
          {PERIODS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setPeriod(item.key)}
              className={`flex-1 whitespace-nowrap rounded px-2 py-1.5 text-center transition-colors ${
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
            className={`flex-1 whitespace-nowrap rounded px-2 py-1.5 text-center transition-colors ${
              period === "custom"
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Custom
          </button>
        </div>
        {period === "custom" && (
          <div className="mt-2">
            <DateRangePicker
              from={customFrom || undefined}
              to={customTo || undefined}
              max={businessDate}
              className="h-9 w-full justify-start text-xs"
              onChange={(nextFrom, nextTo) => {
                setCustomFrom(nextFrom);
                setCustomTo(nextTo);
              }}
            />
          </div>
        )}
      </CardHeader>
      <CardContent className="pt-4">
        <SalesPerformanceChart points={series} />
      </CardContent>
    </Card>
  );
}

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
