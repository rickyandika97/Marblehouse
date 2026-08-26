import { requireOwnerPage } from "@/server/auth/page-guard";
import {
  getBackupStatus,
  listArchives,
  listBackupRuns,
} from "@/server/services/backup";
import { syncBackupAlerts } from "@/server/services/maintenance";
import { BackupScreen } from "./backup-screen";

export const metadata = { title: "Backups · Marblehouse" };
export const dynamic = "force-dynamic";

/**
 * §13.4's backup screen — owner only. A one-tap export, the "I copied this
 * off-machine" log, and the escalation banner that is, per D-71/D-72, the
 * LAST protection left against total loss now that both backup encryption
 * and the automatic USB copy were declined.
 */
export default async function BackupsPage() {
  const actor = await requireOwnerPage();

  // D-75: re-synced on every visit, not just by the nightly cron, so tapping
  // "I copied this off-machine" clears the red banner immediately instead of
  // leaving it up until the next scheduled run fires.
  await syncBackupAlerts();

  const [status, runs, archives] = await Promise.all([
    getBackupStatus(),
    listBackupRuns(actor, 10),
    listArchives(),
  ]);

  return (
    <BackupScreen
      status={{
        lastLocalBackupAt: status.lastLocalBackupAt?.toISOString() ?? null,
        localBackupIsStale: status.localBackupIsStale,
        lastOffsiteCopyAt: status.lastOffsiteCopyAt?.toISOString() ?? null,
        offsiteLevel: status.offsiteLevel,
        offsiteDaysAgo: status.offsiteDaysAgo,
        archiveCount: status.archiveCount,
        message: status.message,
        latestArchiveFileName: status.latestArchive?.fileName ?? null,
      }}
      runs={runs.map((r) => ({
        id: r.id,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        succeeded: r.succeeded,
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
        errorText: r.errorText,
      }))}
      archives={archives.map((a) => ({
        fileName: a.fileName,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt.toISOString(),
      }))}
    />
  );
}
