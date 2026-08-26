import { requireOwner } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import {
  getBackupStatus,
  listArchives,
  listBackupRuns,
  runBackupNow,
} from "@/server/services/backup";

/**
 * §13.4's status panel: local + off-machine escalation state, recent
 * `BackupRun` history and the archives actually on disk.
 *
 * Owner-only. Unlike `/api/health` (deliberately thin and unauthenticated),
 * this is allowed to name filenames and sizes — an authenticated owner is
 * exactly who §13.5 says may see what a backup contains.
 */
export async function GET() {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const [status, runs, archives] = await Promise.all([
      getBackupStatus(),
      listBackupRuns(actor, 10),
      listArchives(),
    ]);

    return {
      status,
      // Prisma's `sizeBytes` is a BigInt, which JSON.stringify cannot
      // serialise. `filePath` is a server-absolute path and stays server-side.
      runs: runs.map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        succeeded: r.succeeded,
        sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
        errorText: r.errorText,
      })),
      archives: archives.map((a) => ({
        fileName: a.fileName,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt,
      })),
    };
  });
}

/** §13.2: "plus on demand from the owner's Backup screen." */
export async function POST() {
  return handleRoute(async () => {
    const actor = await requireOwner();
    return runBackupNow(actor);
  });
}
