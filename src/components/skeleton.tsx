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
 *
 * ── NOTHING RENDERS THESE RIGHT NOW. Do not delete them as dead code. ──
 *
 * They were used by `reports/loading.tsx` and `dashboard/loading.tsx`, both
 * removed on 9 Aug 2026 (D-96). A `loading.tsx` wraps its segment in a
 * Suspense boundary, and Next flushes the shell — headers included — as a
 * **200** the moment the page suspends. That happens in the `(app)` layout,
 * before any page code runs, so a later `forbidden()` or `notFound()` still
 * rendered the right screen under the wrong status: a manager asking for
 * another branch's report got the 403 page with a 200 on it.
 *
 * The fix that keeps both is to check permissions and existence FIRST, then
 * wrap only the slow table in an explicit `<Suspense>` inside the page — the
 * throw then happens before the boundary. That is planned for after the pilot
 * (D-96 records why it was not done during pilot week), and these components
 * are what it will use.
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
