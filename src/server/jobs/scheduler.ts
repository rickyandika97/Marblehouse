/**
 * Background-job registration (PRD §11).
 *
 * All six §11 jobs are registered here. Phase 3 added balance reconciliation
 * at 04:00 and Phase 6 the attendance photo purge at 03:00; Phase 9 adds the
 * remaining four — backup, cleanup, low-stock scan and the weekly nag.
 *
 * Every job is `noOverlap` and runs in the server timezone (v1 assumes one
 * timezone across all branches, §11).
 *
 * **A job must never throw past `register()`.** These run unattended on a
 * machine nobody is watching; an unhandled rejection would take the scheduler
 * — and therefore the backup — down with it, and the first sign would be the
 * staleness alert days later.
 */
import cron from "node-cron";
import { runBalanceReconciliation } from "@/server/services/balances";

declare global {
  var marblehouseJobsStarted: boolean | undefined;
}

const TIMEZONE = process.env.TZ ?? "Asia/Jakarta";

/**
 * Register one cron job with uniform logging and error containment.
 *
 * The body is passed as a thunk returning a summary, which is logged on
 * success. Failures are logged and swallowed deliberately — see the file
 * header.
 */
function register(
  name: string,
  expression: string,
  body: () => Promise<unknown>
): void {
  cron.schedule(
    expression,
    async () => {
      const startedAt = Date.now();
      try {
        const result = await body();
        console.info(`[jobs] ${name}`, result, `(${Date.now() - startedAt}ms)`);
      } catch (error) {
        console.error(`[jobs] ${name} FAILED`, error);
      }
    },
    { name, timezone: TIMEZONE, noOverlap: true }
  );
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

  // ── Phase 9 (§11) ────────────────────────────────────────────────────────
  // Imports are deferred inside each body for the reason D-47 documents:
  // `instrumentation.ts` is compiled for the edge runtime too, and a static
  // import here drags `node:fs`/`child_process` into a bundle that cannot
  // resolve them. The jobs only ever run in the Node runtime.

  // §13.2: 02:00 daily, then retention. BACKUP_CRON allows the owner to move it
  // without a code change — a shop that trades unusually late might want 03:00.
  register(
    "backup",
    process.env.BACKUP_CRON?.trim() || "0 2 * * *",
    async () => {
      const { runBackup, applyRetention } = await import(
        "@/server/services/backup"
      );
      const { syncBackupAlerts } = await import("@/server/services/maintenance");

      const result = await runBackup();
      // Refresh the staleness alerts either way: a FAILED backup must escalate
      // exactly like a missing one, or a week of failures looks like success.
      const retention = result.ok ? await applyRetention() : null;
      await syncBackupAlerts();
      return { ...result, retention };
    }
  );

  // §11: expired sessions (R-9) and idempotency keys past their 24 h TTL.
  // This finally closes D-16 — the table has grown by one row per mutation
  // since Phase 2 with nothing to reclaim it.
  register("cleanup", "0 4 * * *", async () => {
    const { cleanupExpiredData } = await import(
      "@/server/services/maintenance"
    );
    return cleanupExpiredData();
  });

  register("low-stock-scan", "0 8 * * *", async () => {
    const { runLowStockScan } = await import("@/server/services/maintenance");
    return runLowStockScan();
  });

  // §11 + §13.4: Monday 09:00. Uncosted batches (R-8) and the off-machine
  // backup reminder the owner's manual-copy decision depends on.
  register("weekly-nag", "0 9 * * 1", async () => {
    const { runWeeklyNag } = await import("@/server/services/maintenance");
    return runWeeklyNag();
  });
}

