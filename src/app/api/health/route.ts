import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getBackupStatus } from "@/server/services/backup";

export const dynamic = "force-dynamic";

/**
 * Liveness + operational check (PRD §7.9, §13.4).
 *
 * Keep it cheap — the Docker healthcheck calls it every 30 s.
 *
 * §13.4 requires this endpoint to report `lastLocalBackupAt` and
 * `lastOffsiteCopyAt`. It is **unauthenticated**, so it deliberately exposes
 * only timestamps and a status word: when a backup last ran, never what is in
 * it, how big it is, or where it lives on disk. Backup archives contain
 * customer names, phone numbers and password hashes (§13.5), so a filename is
 * not something to hand to an unauthenticated caller.
 */
export async function GET() {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    const backup = await getBackupStatus();

    return NextResponse.json({
      status: "ok",
      database: "connected",
      latencyMs: Date.now() - startedAt,
      timezone: process.env.TZ ?? "unset",
      timestamp: new Date().toISOString(),
      backup: {
        lastLocalBackupAt: backup.lastLocalBackupAt?.toISOString() ?? null,
        localBackupIsStale: backup.localBackupIsStale,
        lastOffsiteCopyAt: backup.lastOffsiteCopyAt?.toISOString() ?? null,
        offsiteLevel: backup.offsiteLevel,
        offsiteDaysAgo: backup.offsiteDaysAgo,
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        status: "error",
        database: "unreachable",
        message: e instanceof Error ? e.message : String(e),
        timestamp: new Date().toISOString(),
      },
      { status: 503 }
    );
  }
}
