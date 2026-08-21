"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Input } from "@/components/ui/input";

/** Server-backed filters for the owner and manager attendance history. */
export function AttendanceFilters({
  from,
  to,
  shopId,
  arrival,
  q,
  outsideSchedule,
  shops,
  businessDate,
}: {
  from?: string;
  to?: string;
  shopId?: string;
  arrival?: "late" | "early";
  q?: string;
  outsideSchedule?: boolean;
  shops: { id: string; name: string }[];
  businessDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [query, setQuery] = useState(q ?? "");
  const [pending, startTransition] = useTransition();

  useEffect(() => setQuery(q ?? ""), [q]);

  function apply(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (!value) params.delete(key);
      else params.set(key, value);
    }
    startTransition(() => {
      router.push(params.size > 0 ? `${pathname}?${params}` : pathname);
    });
  }

  const hasFilters = Boolean(from || to || shopId || arrival || q || outsideSchedule);

  return (
    <div className="space-y-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <form
          className="flex min-w-56 flex-1 items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            apply({ q: query.trim() || null });
          }}
        >
          <label className="flex flex-1 flex-col gap-1 text-xs font-medium text-muted-foreground">
            Employee name
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search employee name…"
              maxLength={120}
              disabled={pending}
            />
          </label>
          <Button type="submit" disabled={pending}>Search</Button>
        </form>

        <DateRangePicker
          from={from}
          to={to}
          max={businessDate}
          onChange={(nextFrom, nextTo) =>
            apply({ from: nextFrom || null, to: nextTo || null })
          }
        />

        {shops.length > 1 && (
          <label className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Shop
            <select
              value={shopId ?? ""}
              disabled={pending}
              onChange={(event) => apply({ shopId: event.target.value || null })}
              className="h-11 rounded-md border bg-transparent px-3 text-sm"
            >
              <option value="">All shops</option>
              {shops.map((shop) => (
                <option key={shop.id} value={shop.id}>{shop.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Arrival</span>
        {([
          ["late", "Late"],
          ["early", "Early"],
        ] as const).map(([value, label]) => (
          <Button
            key={value}
            size="sm"
            variant={arrival === value ? "default" : "outline"}
            disabled={pending}
            onClick={() => apply({ arrival: arrival === value ? null : value })}
          >
            {label}
          </Button>
        ))}
        <Button
          size="sm"
          variant={outsideSchedule ? "default" : "outline"}
          disabled={pending}
          onClick={() => apply({ outsideSchedule: outsideSchedule ? null : "true" })}
        >
          Outside schedule
        </Button>

        {hasFilters && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => apply({ from: null, to: null, shopId: null, arrival: null, q: null, outsideSchedule: null })}
          >
            <X className="size-3.5" />
            Clear
          </Button>
        )}

        {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>
    </div>
  );
}
