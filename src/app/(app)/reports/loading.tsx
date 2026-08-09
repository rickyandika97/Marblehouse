import { ReportSkeleton } from "@/components/skeleton";

/**
 * Loading state for EVERY report screen.
 *
 * One file at the segment root rather than one per report: Next applies a
 * `loading.tsx` to all nested routes, and every §9 screen shares the same
 * totals-row-plus-table shape. A per-report copy would be fifteen files that
 * drift.
 */
export default function ReportsLoading() {
  return <ReportSkeleton />;
}
