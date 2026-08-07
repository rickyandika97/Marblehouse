/**
 * Attendance photo retention (PRD §4.15, §11).
 *
 * Photos are kept **61 days**. A nightly job deletes the files, nulls
 * `photoPath` and sets `photoPurgedAt`.
 *
 * **The attendance record itself is kept forever.** Only the image goes.
 * Lateness history has to survive — it is the reason the record exists — so
 * there is deliberately no `attendance.delete` anywhere in this file. Deleting
 * the row would also destroy the evidence for any wage discussion that made
 * someone want the photo gone in the first place.
 *
 * Ordering matters: the FILE is removed first, then the row is updated. A crash
 * between them leaves a row pointing at a missing file, which the photo route
 * already handles as a 404. The opposite order would leave an orphan file on
 * disk that nothing knows about and nothing will ever clean up.
 */
import { prisma } from "@/lib/prisma";
import { deleteAttendancePhoto } from "@/server/services/attendance-photo";

export const RETENTION_DAYS = 61;

/** The business date on or before which photos are past retention. */
export function purgeCutoff(today: Date = new Date(), days = RETENTION_DAYS): Date {
  const cutoff = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  );
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  return cutoff;
}

export interface PurgeResult {
  scanned: number;
  purged: number;
  failed: number;
}

/**
 * Delete attendance photos past their retention window.
 *
 * Batched so a long-neglected instance cannot try to unlink a hundred thousand
 * files in one transaction.
 */
export async function purgeExpiredAttendancePhotos(
  today: Date = new Date(),
  batchSize = 500
): Promise<PurgeResult> {
  const cutoff = purgeCutoff(today);

  const due = await prisma.attendance.findMany({
    where: {
      businessDate: { lt: cutoff },
      photoPath: { not: null },
    },
    orderBy: { businessDate: "asc" },
    take: batchSize,
    select: { id: true, photoPath: true, clockOutPhotoPath: true },
  });

  let purged = 0;
  let failed = 0;

  for (const row of due) {
    try {
      if (row.photoPath) await deleteAttendancePhoto(row.photoPath);
      if (row.clockOutPhotoPath) {
        await deleteAttendancePhoto(row.clockOutPhotoPath);
      }

      // The RECORD survives — only the image reference is cleared (§4.15).
      await prisma.attendance.update({
        where: { id: row.id },
        data: {
          photoPath: null,
          clockOutPhotoPath: null,
          photoPurgedAt: new Date(),
        },
      });
      purged += 1;
    } catch (error) {
      // One unreadable file must not stop the rest of the sweep.
      failed += 1;
      console.error("[photo-retention] could not purge", row.id, error);
    }
  }

  return { scanned: due.length, purged, failed };
}
