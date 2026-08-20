"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { cn } from "@/lib/utils";

/**
 * Date-range and shop filters for the §9 report screens.
 *
 * Navigates by changing the URL rather than holding report data in client
 * state. That keeps every report screen a server component — the page re-runs
 * with new search params and the service re-resolves scope and permissions from
 * scratch. A client-side filter would have meant fetching report JSON into the
 * browser, which is exactly what the cost gate is designed to avoid for a
 * manager (§7.5).
 *
 * **The shop picker never offers "All shops" to a manager.** §3.4 gives them one
 * shop at a time. That is not enforced here — `resolveScope` validates every
 * `shopId` server-side and 403s a foreign one (R-4) — this only avoids showing
 * a control that would fail.
 */
export interface ShopOption {
  id: string;
  name: string;
}

export function ReportFilters({
  from,
  to,
  shopId,
  shops,
  canSeeAllShops,
  businessDate,
}: {
  from: string;
  to: string;
  shopId?: string;
  shops: ShopOption[];
  canSeeAllShops: boolean;
  /** The actor's business date — presets anchor to this, never to `new Date()`. */
  businessDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function apply(next: { from?: string; to?: string; shopId?: string | null }) {
    const params = new URLSearchParams(searchParams.toString());
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    if (next.shopId === null) params.delete("shopId");
    else if (next.shopId !== undefined) params.set("shopId", next.shopId);

    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }

  const presets = buildPresets(businessDate);
  const activePreset = presets.find((p) => p.from === from && p.to === to);

  return (
    <div className="space-y-3 rounded-lg border p-3">
      {/* ── Presets: the questions actually asked daily, one tap each ── */}
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant={activePreset?.label === p.label ? "default" : "outline"}
            onClick={() => apply({ from: p.from, to: p.to })}
            disabled={pending}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {/* ── Custom range ── */}
        <DateRangePicker
          from={from}
          to={to}
          max={businessDate}
          onChange={(nextFrom, nextTo) => {
            if (nextFrom && nextTo) apply({ from: nextFrom, to: nextTo });
          }}
        />

        {/* ── Shop ── */}
        {shops.length > 0 && (
          <label className="ml-auto flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Shop
            <select
              value={shopId ?? ""}
              disabled={pending}
              onChange={(e) => apply({ shopId: e.target.value || null })}
              className={cn(
                "h-11 rounded-md border bg-transparent px-3 text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              )}
            >
              {/* Owner only. A manager choosing "" would be asking for an
                  aggregate across their assignments, which §3.4 forbids. */}
              {canSeeAllShops && <option value="">All shops</option>}
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {pending && (
          <span className="flex items-center gap-1.5 pb-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * Preset ranges, anchored to the actor's BUSINESS date.
 *
 * Never `new Date()`: before 04:00 the business day is still yesterday (§4.2,
 * D-18), and a "Today" preset built from the wall clock would ask for a date
 * that no row is filed under yet — an empty report at 2am, which reads as a
 * broken screen rather than a boundary.
 */
function buildPresets(businessDate: string) {
  const anchor = new Date(`${businessDate}T00:00:00.000Z`);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const shift = (days: number) =>
    new Date(anchor.getTime() + days * 86_400_000);

  const monthStart = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1)
  );
  const lastMonthStart = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() - 1, 1)
  );
  const lastMonthEnd = new Date(monthStart.getTime() - 86_400_000);

  return [
    { label: "Today", from: businessDate, to: businessDate },
    { label: "7 days", from: iso(shift(-6)), to: businessDate },
    { label: "30 days", from: iso(shift(-29)), to: businessDate },
    { label: "This month", from: iso(monthStart), to: businessDate },
    { label: "Last month", from: iso(lastMonthStart), to: iso(lastMonthEnd) },
  ];
}
