"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { cn } from "@/lib/utils";

/**
 * §8.8's expense filters: date range, category, and shop.
 *
 * **The category chips here are NOT the add form's category chips.** They look
 * alike and mean opposite things — one asks "show me Rent", the other arms the
 * form to record a Rent expense. Sharing state between them would mean picking
 * a category to record silently re-filtered the list out from under you. They
 * are deliberately separate components with separate state.
 *
 * Filters live in the URL and the page re-renders on the server, the same shape
 * the report screens use. That keeps the list, the running total and the
 * "load more" cursor consistent: all three come from one `listExpenses` call
 * with one set of parameters.
 */
export function ExpenseFilters({
  from,
  to,
  categoryId,
  shopId,
  categories,
  shops,
  businessDate,
  isDefaultView = false,
}: {
  from?: string;
  to?: string;
  categoryId?: string;
  shopId?: string;
  categories: { id: string; name: string }[];
  shops: { id: string; name: string }[];
  /** The actor's business date — presets anchor here, never the wall clock. */
  businessDate: string;
  /**
   * True when nothing was actually in the URL and `from`/`to` are only the
   * page's own "current month" default — "Clear" has nothing to clear yet,
   * even though the resolved range matches the "This month" preset.
   */
  isDefaultView?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function apply(next: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(next)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    // Any filter change invalidates the paging cursor — keeping it would ask
    // for "the next page" of a list that no longer exists.
    params.delete("cursor");

    startTransition(() => {
      router.push(params.size > 0 ? `${pathname}?${params}` : pathname);
    });
  }

  const presets = buildPresets(businessDate);
  const active = presets.find((p) => p.from === from && p.to === to);
  const hasAnyFilter = !isDefaultView && Boolean(from || to || categoryId);

  return (
    <div className="space-y-3 rounded-xl border p-3">
      <div className="flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant={active?.label === p.label ? "default" : "outline"}
            disabled={pending}
            onClick={() => apply({ from: p.from, to: p.to })}
          >
            {p.label}
          </Button>
        ))}

        {hasAnyFilter && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => apply({ from: null, to: null, categoryId: null })}
          >
            <X className="size-3.5" />
            Clear
          </Button>
        )}

        {pending && (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <DateRangePicker
          from={from}
          to={to}
          max={businessDate}
          onChange={(nextFrom, nextTo) =>
            apply({ from: nextFrom || null, to: nextTo || null })
          }
        />

        {shops.length > 1 && (
          <label className="ml-auto flex flex-col gap-1 text-xs font-medium text-muted-foreground">
            Shop
            <select
              value={shopId ?? ""}
              disabled={pending}
              onChange={(e) => apply({ shopId: e.target.value || null })}
              className="h-11 rounded-md border bg-transparent px-3 text-sm"
            >
              {/* HQ belongs in this list (§4.12, D-54) — it is where a
                  non-branch cost is recorded, so it must be filterable too. */}
              <option value="">All my shops</option>
              {shops.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {categories.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Category</p>
          <ul className="flex flex-wrap gap-2">
            {categories.map((c) => {
              const on = categoryId === c.id;
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    // Tapping the active chip clears it — a filter you cannot
                    // switch off is a trap on a screen with no obvious reset.
                    onClick={() => apply({ categoryId: on ? null : c.id })}
                    aria-pressed={on}
                    disabled={pending}
                    className={cn(
                      "min-h-11 rounded-lg border px-3 text-sm",
                      on
                        ? "border-primary bg-primary text-primary-foreground"
                        : "hover:bg-muted"
                    )}
                  >
                    {c.name}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Anchored to the BUSINESS date — before 04:00 that is still yesterday (D-18). */
function buildPresets(businessDate: string) {
  const anchor = new Date(`${businessDate}T00:00:00.000Z`);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const shift = (days: number) => new Date(anchor.getTime() + days * 86_400_000);
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
