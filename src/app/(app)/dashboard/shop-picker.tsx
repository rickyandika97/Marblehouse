"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * §8.3's shop filter: `All shops` (the owner's default) or a single shop.
 *
 * Deliberately NOT the report screens' `ReportFilters`. That control carries a
 * date range, and the dashboard has no range to set — §8.3 fixes its periods
 * (today, this month, last 30 days). Reusing it would have meant rendering
 * date inputs that do nothing, which teaches people the controls are unreliable.
 *
 * Owner-only in practice: a manager is locked to one shop (§3.4) and their
 * dashboard resolves from their work session, so `ManagerDashboard` never
 * renders this. The server re-checks regardless — `resolveScope` 403s a shop
 * outside an actor's assignments and 404s one that does not exist.
 */
export function DashboardShopPicker({
  shopId,
  shops,
}: {
  shopId?: string;
  shops: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  // Nothing to choose between: one shop is not a filter.
  if (shops.length < 2) return null;

  function select(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "") params.delete("shopId");
    else params.set("shopId", next);

    startTransition(() => {
      router.push(params.size > 0 ? `${pathname}?${params}` : pathname);
    });
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground">Showing</span>
      <select
        value={shopId ?? ""}
        disabled={pending}
        onChange={(e) => select(e.target.value)}
        className={cn(
          "h-11 rounded-md border bg-transparent px-3 text-sm font-medium",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        )}
      >
        <option value="">All shops</option>
        {shops.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      {pending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
    </label>
  );
}
