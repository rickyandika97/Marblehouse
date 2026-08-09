import { Skeleton } from "@/components/skeleton";

/**
 * Loading state for the dashboard (§8.3).
 *
 * This is the owner's landing screen and the heaviest read in the app — five
 * rows of aggregates across every branch. It is also the page most likely to be
 * opened on a phone away from the shop, where the wait is longest.
 *
 * The shape mirrors §8.3's rows so the layout does not jump: five stat tiles,
 * three period cards, two charts, then the alerts panel.
 */
export default function DashboardLoading() {
  return (
    <div className="space-y-6" aria-busy role="status" aria-label="Loading dashboard">
      <div className="space-y-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-4 w-56" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24" />
        ))}
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>

      <Skeleton className="h-40" />
    </div>
  );
}
