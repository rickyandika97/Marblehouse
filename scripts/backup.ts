/**
 * On-demand backup (PRD §13.1, §13.2).
 *
 *   npm run backup
 *
 * The same code the 02:00 cron job runs — `runBackup()` then `applyRetention()`
 * from `src/server/services/backup.ts`. There is deliberately no second
 * implementation here: a restore is only as trustworthy as the archive it
 * reads, and two ways of writing one is two ways to get it wrong.
 *
 * Exit codes: 0 backup written · 1 backup failed.
 */
import { prisma } from "../src/lib/prisma";
import {
  applyRetention,
  runBackup,
  BACKUP_ROOT,
} from "../src/server/services/backup";

async function main() {
  console.log(`Backing up to ${BACKUP_ROOT} …`);

  const result = await runBackup();
  if (!result.ok) {
    console.error(`FAILED: ${result.error}`);
    process.exitCode = 1;
    return;
  }

  const mb = ((result.sizeBytes ?? 0) / 1_048_576).toFixed(1);
  console.log(`Wrote ${result.fileName} (${mb} MB)`);

  const retention = await applyRetention();
  if (retention.skippedForSafety) {
    // §13.2: never delete your way to zero. Worth saying out loud rather than
    // logging silence — it means retention is not doing what you think it is.
    console.warn(
      `Retention SKIPPED: deleting would leave fewer than the minimum ` +
        `number of backups. ${retention.kept} archive(s) kept.`
    );
  } else if (retention.deleted.length > 0) {
    console.log(
      `Retention: deleted ${retention.deleted.length} old archive(s), ` +
        `${retention.kept} kept.`
    );
  } else {
    console.log(`Retention: nothing to delete, ${retention.kept} archive(s) kept.`);
  }

  console.log(
    "\nThis backup is on the SAME MACHINE as the database. Copy it off — " +
      "then tap “I copied this off-machine” in Settings → Backups."
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
