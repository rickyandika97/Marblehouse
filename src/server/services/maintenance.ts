/**
 * Housekeeping jobs (PRD §11) and the operational alerts they raise.
 *
 * Four jobs live here; the backup itself is in `backup.ts`, and Phase 3's
 * balance reconciliation and Phase 6's photo purge already have their own
 * files. What they share is the shape: each is callable on its own, returns a
 * summary the scheduler can log, and NEVER throws past the caller for an
 * operational condition — a job that crashes the scheduler takes the other
 * jobs down with it.
 *
 * Alerts are written to `SystemAlert`, which the owner dashboard already reads
 * (Phase 3, D-22). That is deliberately the only channel: an alert nobody sees
 * is not a control, and the dashboard is the one screen the owner opens daily.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  LOCAL_BACKUP_STALE_HOURS,
  OFFSITE_RED_DAYS,
  getBackupStatus,
} from "@/server/services/backup";

/** §11: idempotency keys older than this are reclaimable. */
export const IDEMPOTENCY_KEY_TTL_HOURS = 24;

export const ALERT_BACKUP_STALE = "BACKUP_STALE";
export const ALERT_BACKUP_OFFSITE = "BACKUP_OFFSITE_STALE";
export const ALERT_LOW_STOCK = "LOW_STOCK";
export const ALERT_UNCOSTED_BATCHES = "UNCOSTED_BATCHES";

type AlertSeverity = "CRITICAL" | "WARNING";

/**
 * Raise or refresh an alert.
 *
 * Upsert rather than insert, keyed on a stable string, so a condition that
 * persists for a week is ONE row that keeps its `firstSeenAt` — not seven rows
 * that bury everything else on the dashboard. `firstSeenAt` is what tells the
 * owner how long this has been true, which is the part that should worry them.
 */
async function raiseAlert(
  key: string,
  severity: AlertSeverity,
  title: string,
  message: string,
  details?: Prisma.InputJsonValue
): Promise<void> {
  const now = new Date();
  await prisma.systemAlert.upsert({
    where: { key },
    update: {
      severity,
      title,
      message,
      details: details ?? undefined,
      isActive: true,
      lastSeenAt: now,
      resolvedAt: null,
    },
    create: {
      key,
      severity,
      title,
      message,
      details: details ?? undefined,
      firstSeenAt: now,
      lastSeenAt: now,
    },
  });
}

/**
 * Clear an alert whose condition no longer holds.
 *
 * Deliberately `updateMany` with `isActive: true` in the filter: if the alert
 * is already resolved this writes nothing, so `resolvedAt` records when the
 * problem actually went away rather than when the job last ran.
 *
 * Balance-drift alerts (D-22) are NOT resolved this way and must not be — they
 * are evidence that drift happened, and they stay until the owner has seen
 * them. These operational alerts are different: "stock is low" stops being
 * true when stock is restocked.
 */
async function clearAlert(key: string): Promise<void> {
  await prisma.systemAlert.updateMany({
    where: { key, isActive: true },
    data: { isActive: false, resolvedAt: new Date() },
  });
}

/**
 * §11's session cleanup — and D-16's long-standing debt.
 *
 * Expired sessions and idempotency keys older than 24 h are both pure garbage:
 * the session layer already refuses an expired session, and `runIdempotent`
 * only ever matches a key inside its TTL. Deleting them reclaims disk, nothing
 * more — which is exactly why this never ran until now (D-16) and why the
 * table has been growing by one row per mutation since Phase 2.
 *
 * The 24 h TTL is §11's, and it is deliberately longer than any plausible
 * retry window. Deleting a key that a client might still replay would turn a
 * double-tap back into a double sale, which is the one thing this whole
 * mechanism exists to prevent.
 */
export async function cleanupExpiredData(now: Date = new Date()): Promise<{
  sessionsDeleted: number;
  idempotencyKeysDeleted: number;
}> {
  const keyCutoff = new Date(
    now.getTime() - IDEMPOTENCY_KEY_TTL_HOURS * 3_600_000
  );

  const [sessions, keys] = await Promise.all([
    prisma.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    prisma.idempotencyKey.deleteMany({ where: { createdAt: { lt: keyCutoff } } }),
  ]);

  return {
    sessionsDeleted: sessions.count,
    idempotencyKeysDeleted: keys.count,
  };
}

/**
 * §11's 08:00 low-stock scan.
 *
 * Calls `lowStockRowsForScope` — the same function the dashboard uses — over
 * every active shop, rather than reimplementing the threshold comparison. Two
 * definitions of "low" that drift apart would have the dashboard and the alert
 * disagreeing about whether there is a problem.
 */
export async function runLowStockScan(): Promise<{
  lowCount: number;
  shopsAffected: number;
}> {
  const shops = await prisma.shop.findMany({
    where: { isActive: true, isHqPseudoShop: false },
    select: { id: true },
  });
  const shopIds = shops.map((s) => s.id);

  if (shopIds.length === 0) {
    await clearAlert(ALERT_LOW_STOCK);
    return { lowCount: 0, shopsAffected: 0 };
  }

  // Imported HERE, not at module scope, and this is load-bearing (D-47).
  // `reports.ts` reaches `auth/context` → `auth.ts` → argon2's native binary.
  // This module is reachable from `instrumentation.ts` via the scheduler, and
  // instrumentation is compiled for the edge runtime too, so a static import
  // breaks the dev server outright with "Can't resolve
  // '@node-rs/argon2-wasm32-wasi'". Caught by booting the app, not by
  // typecheck or lint — which is exactly what D-33 warns about.
  const { lowStockRowsForScope } = await import("@/server/services/reports");

  // `from`/`to` are part of ResolvedScope's contract but `lowStockRowsForScope`
  // does not read them — on-hand is a point-in-time figure summed from batches,
  // not a range aggregate. Passing the current instant for both is the honest
  // encoding of "as of now" rather than an invented window.
  const asOf = new Date();
  const rows = await lowStockRowsForScope({
    shopIds,
    isAllShops: true,
    from: asOf,
    to: asOf,
  });
  const shopsAffected = new Set(rows.map((r) => r.shopId)).size;

  if (rows.length === 0) {
    await clearAlert(ALERT_LOW_STOCK);
    return { lowCount: 0, shopsAffected: 0 };
  }

  await raiseAlert(
    ALERT_LOW_STOCK,
    "WARNING",
    `${rows.length} prize${rows.length === 1 ? "" : "s"} low on stock`,
    `${rows.length} prize/shop combination${rows.length === 1 ? " is" : "s are"} at or below the low-stock threshold across ${shopsAffected} branch${shopsAffected === 1 ? "" : "es"}.`,
    {
      lowCount: rows.length,
      shopsAffected,
      items: rows.slice(0, 20).map((r) => ({
        shop: r.shopName,
        prize: r.prizeName,
        onHand: r.onHand,
        threshold: r.lowStockThreshold,
      })),
    }
  );

  return { lowCount: rows.length, shopsAffected };
}

/**
 * §11's Monday 09:00 nag, covering both weekly reminders in one job.
 *
 * 1. Uncosted batches (§7.5, R-8) — they understate prize expense for as long
 *    as they sit there, and the figure silently looks better than it is.
 * 2. The off-machine backup copy (§13.4) — the weekly reminder the owner's
 *    manual-copy decision depends on.
 *
 * The second is the one that matters most here. With encryption and the USB
 * copy both declined (BUILD-LOG D-71, D-72), the owner's own discipline is the
 * ONLY thing protecting the business from total loss, and §13.4 is explicit
 * that its failure mode is silent.
 */
export async function runWeeklyNag(now: Date = new Date()): Promise<{
  uncostedBatches: number;
  offsiteLevel: string;
}> {
  const uncosted = await prisma.prizeBatch.count({
    where: { needsCosting: true, isVoid: false },
  });

  if (uncosted > 0) {
    await raiseAlert(
      ALERT_UNCOSTED_BATCHES,
      "WARNING",
      `${uncosted} stock batch${uncosted === 1 ? "" : "es"} awaiting a cost`,
      `Prize expense and profit are understated until ${uncosted === 1 ? "it is" : "they are"} priced. Settings → Stock → Batches awaiting cost.`,
      { uncosted }
    );
  } else {
    await clearAlert(ALERT_UNCOSTED_BATCHES);
  }

  const status = await getBackupStatus(now);
  await syncBackupAlerts(now);

  return { uncostedBatches: uncosted, offsiteLevel: status.offsiteLevel };
}

/**
 * Keep the two backup alerts in step with reality (§13.2, §13.4).
 *
 * Called by the backup job, the weekly nag, and after an owner records an
 * off-machine copy — so tapping the button clears the red banner immediately
 * rather than leaving it up until a cron fires and making the owner wonder
 * whether the tap registered.
 *
 * The offsite alert is CRITICAL from 14 days (§13.4's red), WARNING from 7
 * (amber). Below that it is cleared. The dashboard renders CRITICAL alerts
 * undismissably, which is what §13.4 asks for.
 */
export async function syncBackupAlerts(now: Date = new Date()): Promise<void> {
  const status = await getBackupStatus(now);

  // §13.2: red if the last SUCCESSFUL local backup is older than 36 hours.
  if (status.localBackupIsStale) {
    const when = status.lastLocalBackupAt
      ? `The last successful backup was ${status.lastLocalBackupAt.toISOString().slice(0, 16).replace("T", " ")}.`
      : "No successful backup has ever completed.";
    await raiseAlert(
      ALERT_BACKUP_STALE,
      "CRITICAL",
      "Backups are not running",
      `${when} Backups should run daily at 02:00. Until this is fixed, everything since the last backup would be lost if this machine failed.`,
      {
        lastLocalBackupAt: status.lastLocalBackupAt?.toISOString() ?? null,
        staleAfterHours: LOCAL_BACKUP_STALE_HOURS,
      }
    );
  } else {
    await clearAlert(ALERT_BACKUP_STALE);
  }

  // §13.4's escalation. `message` is built in backup.ts so the dashboard, the
  // settings screen and this alert all say the same thing.
  if (status.offsiteLevel === "green") {
    await clearAlert(ALERT_BACKUP_OFFSITE);
    return;
  }

  await raiseAlert(
    ALERT_BACKUP_OFFSITE,
    status.offsiteLevel === "red" ? "CRITICAL" : "WARNING",
    status.offsiteLevel === "red"
      ? "No off-machine backup copy"
      : "Off-machine backup copy is overdue",
    status.message ?? "Copy a backup off this machine.",
    {
      lastOffsiteCopyAt: status.lastOffsiteCopyAt?.toISOString() ?? null,
      daysAgo: status.offsiteDaysAgo,
      redAfterDays: OFFSITE_RED_DAYS,
    }
  );
}
