/**
 * Background-job registration (PRD §11).
 *
 * Phase 3 added balance reconciliation at 04:00; Phase 6 adds the attendance
 * photo purge at 03:00. Both are guarded by `noOverlap` and run in the server
 * timezone.
 */
import cron from "node-cron";
import { runBalanceReconciliation } from "@/server/services/balances";

declare global {
  var marblehouseJobsStarted: boolean | undefined;
}

export function startBackgroundJobs(): void {
  if (globalThis.marblehouseJobsStarted) return;
  globalThis.marblehouseJobsStarted = true;

  cron.schedule(
    "0 4 * * *",
    async () => {
      try {
        const result = await runBalanceReconciliation();
        console.info("[jobs] balance reconciliation", result);
      } catch (error) {
        console.error("[jobs] balance reconciliation failed", error);
      }
    },
    {
      name: "balance-reconciliation",
      timezone: process.env.TZ ?? "Asia/Jakarta",
      noOverlap: true,
    }
  );

  // §4.15 / §11: delete attendance photos past 61 days. The RECORDS survive —
  // only the images go, so lateness history is never lost.
  cron.schedule(
    "0 3 * * *",
    async () => {
      try {
        // Imported at call time, not at module scope. `instrumentation.ts` is
        // analysed for several runtimes, and a static import here drags the
        // photo module — and through it `sharp` and `node:crypto` — into a
        // bundle that cannot resolve Node built-ins. The job only ever runs in
        // the Node runtime, so deferring the import costs nothing.
        const { purgeExpiredAttendancePhotos } = await import(
          "@/server/services/photo-retention"
        );
        const result = await purgeExpiredAttendancePhotos();
        console.info("[jobs] attendance photo purge", result);
      } catch (error) {
        console.error("[jobs] attendance photo purge failed", error);
      }
    },
    {
      name: "attendance-photo-purge",
      timezone: process.env.TZ ?? "Asia/Jakarta",
      noOverlap: true,
    }
  );
}

