"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { formatMoney } from "@/lib/money";
import type { ShopDailySalesRow } from "@/server/services/reports";

type Period = "today" | "7d" | "month" | "90d" | "custom";

/**
 * "This month" replaced the old "30 days" at the owner's request (D-182): a
 * rolling 30-day window and a calendar month answer different questions, and
 * the one the owner actually asks of this card is "how are the branches doing
 * this month" — which has to agree with the monthly figures elsewhere.
 */
const PERIODS: Array<{ key: Exclude<Period, "custom">; label: string }> = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "month", label: "This month" },
  { key: "90d", label: "90 days" },
];

/** §5.6: past ~8 series the bars stop being readable. */
const CHART_SHOP_LIMIT = 8;

function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** First day of `iso`'s calendar month, as `YYYY-MM-DD`. */
function monthStartIso(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * The window each period covers, as inclusive ISO bounds. `today` is the
 * server's business date — never the browser's clock, which can sit in a
 * different timezone and would shift every branch's takings by a day.
 */
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

/**
 * Revenue by shop, resliceable by period.
 *
 * Filters a 180-day daily series CLIENT-side, the same way the sales chart
 * filters `trend180d`, so switching period is instant and costs no round-trip.
 * Anything older than 180 days is outside what the payload carries, which is
 * why a custom range reaching further back simply shows the days it does have.
 */
export function OwnerRevenueByShop({
  daily,
  businessDate,
}: {
  daily: ShopDailySalesRow[];
  businessDate: string;
}) {
  const [period, setPeriod] = useState<Period>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const { from, to } =
    period === "custom"
      ? { from: customFrom, to: customTo }
      : windowFor(period, businessDate);

  const rows = useMemo(() => {
    // An unfinished custom range shows the card empty rather than guessing at
    // a bound the owner has not picked yet.
    if (period === "custom" && (!from || !to)) return [];

    const totals = new Map<string, { shopName: string; revenue: number }>();
    for (const row of daily) {
      if (row.businessDate < from || row.businessDate > to) continue;
      const seen = totals.get(row.shopId);
      if (seen) seen.revenue += Number(row.revenue);
      else totals.set(row.shopId, { shopName: row.shopName, revenue: Number(row.revenue) });
    }

    const sorted = Array.from(totals, ([shopId, v]) => ({ shopId, ...v })).sort(
      (a, b) => b.revenue - a.revenue
    );

    // Rank first, THEN roll up — the top 8 of the selected period, not of some
    // other window. Mirrors `topShopsWithOthers` on the server.
    if (sorted.length <= CHART_SHOP_LIMIT) return sorted;
    const rest = sorted.slice(CHART_SHOP_LIMIT);
    return [
      ...sorted.slice(0, CHART_SHOP_LIMIT),
      {
        shopId: "OTHERS",
        shopName: `Others (${rest.length})`,
        revenue: rest.reduce((sum, r) => sum + r.revenue, 0),
      },
    ];
  }, [daily, from, to, period]);

  return (
    <Card>
      <CardHeader className="border-b pb-3">
        <CardTitle>Revenue by shop</CardTitle>
        <p className="text-xs text-muted-foreground">
          {periodLabel(period, customFrom, customTo)}
        </p>
        <div className="mt-2 flex items-center rounded-md border bg-muted/50 p-0.5 text-[11px]">
          {PERIODS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setPeriod(item.key)}
              className={`flex-1 whitespace-nowrap rounded px-1.5 py-1.5 text-center transition-colors ${
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
            className={`flex-1 whitespace-nowrap rounded px-1.5 py-1.5 text-center transition-colors ${
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
        <ShopBars rows={rows} />
      </CardContent>
    </Card>
  );
}

function ShopBars({
  rows,
}: {
  rows: { shopId: string; shopName: string; revenue: number }[];
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No sales in this period yet.</p>;
  }
  const max = Math.max(...rows.map((r) => r.revenue), 1);
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.shopId}>
          <div className="flex justify-between text-sm">
            <span className="truncate">{r.shopName}</span>
            <span className="ml-2 shrink-0 tabular-nums">{formatMoney(r.revenue.toString())}</span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded bg-muted">
            <div
              className="h-1.5 rounded bg-foreground/70"
              style={{ width: `${Math.max((r.revenue / max) * 100, 1)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
