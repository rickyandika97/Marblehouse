/** Background-job registration. Phase 3 schedules balance reconciliation only. */
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
}

