import { cn } from "@/lib/utils";

/**
 * Loading placeholders (§16 Phase 10).
 *
 * These exist because every report page is `force-dynamic` and runs real
 * aggregate queries over a 30-day window — on shop wifi that is a visible wait,
 * and Next renders *nothing* until the server component resolves. A blank
 * screen for a second reads as "the app is broken" and gets the page reloaded,
 * which starts the query again.
 *
 * Deliberately a **layout echo**, not a spinner: the blocks sit where the
 * totals row and table will actually appear, so the page does not jump when
 * the data lands. A spinner centred in an empty page tells you something is
 * happening but not what is coming.
 *
 * `animate-pulse` only — no shimmer sweep. NF-1 budgets two seconds on 4G and
 * this must not become the reason a tablet's paint is slow.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      // Announced as busy rather than read out as gibberish by a screen reader.
      aria-hidden
    />
  );
}

/** The totals row + table shape every §9 report screen shares. */
export function ReportSkeleton() {
  return (
    <div className="space-y-6" aria-busy role="status" aria-label="Loading report">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>

      <Skeleton className="h-64" />
    </div>
  );
}
