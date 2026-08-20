/**
 * Backup, retention and the off-machine copy log (PRD §13).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Why this file matters more than it looks
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The owner decided on 3 Aug 2026 that backups are written locally and copied
 * off-machine BY HAND (§13.4, decision 8). On 8 Aug 2026 they also declined
 * backup encryption (§13.5) and the permanently-attached USB drive (§13.4).
 * Both were deliberate, informed choices — see BUILD-LOG D-71 and D-72.
 *
 * The consequence is that NOTHING automatic protects this business from losing
 * everything when the disk dies. The only surviving control is the owner
 * actually copying an archive off the machine, and §13.4 names the failure
 * mode exactly: it is silent, and you discover the discipline slipped on the
 * day the machine dies.
 *
 * That is why `offsiteStatus()` below escalates and why its red state is
 * blunt. It is not UI decoration; it is the mitigation for R-2, and it is the
 * last one standing. Do not soften the copy, and do not make the red state
 * dismissible.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * What a backup contains (§13.1)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   1. `database.dump`  — pg_dump -Fc of the WHOLE database (users, password
 *                         hashes, sales, ledgers, stock — everything).
 *   2. `data.tar.gz`    — attendance photos, receipts and prize images from
 *                          DATA_DIR. It archives the whole root, so a new image
 *                          type is covered without touching this file (D-118).
 *   3. `manifest.json`  — app version, migration name, timestamp, per-table
 *                         row counts, and a SHA-256 of each of the two files.
 *
 * All three are packed into `marblehouse-YYYY-MM-DD-HHmm.tar.gz` with a
 * `.sha256` sidecar for the archive itself.
 *
 * The manifest's row counts are what make a restore verifiable. `restore.sh`
 * re-counts after loading and prints a diff, because §13.3 is explicit: a
 * restore that silently loses 5% of rows is worse than one that fails loudly.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/server/auth/context";
import { AppError, forbidden } from "@/server/errors";
import { writeAudit } from "@/server/audit";

export const LAST_OFFSITE_COPY_KEY = "lastOffsiteCopyAt";

/**
 * §13.2's thresholds, and §13.4's escalation ladder.
 *
 * `MIN_SURVIVING_BACKUPS` is the one that stops a bug becoming a catastrophe:
 * retention deletes nothing unless at least this many valid archives would
 * remain afterwards. Never delete your way to zero.
 */
export const BACKUP_KEEP_COUNT = 7;
export const MIN_SURVIVING_BACKUPS = 3;
export const LOCAL_BACKUP_STALE_HOURS = 36;
export const OFFSITE_AMBER_DAYS = 7;
export const OFFSITE_RED_DAYS = 14;

const ARCHIVE_PREFIX = "marblehouse-";
const ARCHIVE_SUFFIX = ".tar.gz";

/**
 * Where archives live. Mirrors `resolveDataRoot()` in attendance-photo.ts, and
 * for the same reason: `.env` ships `BACKUP_DIR=/backups`, which is the path
 * INSIDE the container. On the dev Mac that resolves to the filesystem root,
 * where mkdir fails.
 *
 * So an absolute BACKUP_DIR is honoured only when that directory ITSELF
 * already exists — testing the directory rather than its parent, because `/`
 * exists on macOS too and a parent check would hand back `/backups` and then
 * fail. The Dockerfile creates `/backups`, so production always wins.
 */
function resolveBackupRoot(): string {
  const configured = process.env.BACKUP_DIR;
  const localDefault = path.join(process.cwd(), "backups");
  if (!configured) return localDefault;
  if (!path.isAbsolute(configured))
    return path.resolve(process.cwd(), configured);

  return existsSync(configured) ? configured : localDefault;
}

export const BACKUP_ROOT = resolveBackupRoot();

export type BackupArchive = {
  fileName: string;
  filePath: string;
  sizeBytes: number;
  createdAt: Date;
};

export type ManifestTableCount = { table: string; rows: number };

export type BackupManifest = {
  formatVersion: 1;
  appVersion: string;
  schemaMigration: string | null;
  createdAt: string;
  databaseName: string;
  tableCounts: ManifestTableCount[];
  totalRows: number;
  files: { name: string; sha256: string; sizeBytes: number }[];
};

/**
 * Row counts for the manifest.
 *
 * Read from `information_schema` rather than a hardcoded model list, so a
 * table added in a later phase is covered without anyone remembering to update
 * this. A manifest that silently stops counting a new table would make a
 * restore look clean while losing all of it.
 *
 * `n_live_tup` from the stats collector is an ESTIMATE and is deliberately not
 * used — this number is the thing a restore is checked against, so it has to
 * be exact even on a big table.
 */
export async function tableRowCounts(
  client: Prisma.TransactionClient = prisma
): Promise<ManifestTableCount[]> {
  const tables = await client.$queryRaw<{ table_name: string }[]>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE '\\_prisma%'
    ORDER BY table_name
  `;

  const counts: ManifestTableCount[] = [];
  for (const { table_name } of tables) {
    const rows = await client.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "${table_name}"`
    );
    counts.push({ table: table_name, rows: Number(rows[0]?.count ?? 0) });
  }

  return counts;
}

async function currentMigrationName(): Promise<string | null> {
  try {
    const rows = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
      ORDER BY finished_at DESC
      LIMIT 1
    `;
    return rows[0]?.migration_name ?? null;
  } catch {
    // A database with no migration table is not a reason to refuse a backup.
    return null;
  }
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

/**
 * Run a command, rejecting on a non-zero exit.
 *
 * stderr is captured and attached to the error: a `pg_dump` failure is almost
 * always explained on stderr, and a BackupRun row recording only "exit 1"
 * would send the owner to the logs at exactly the wrong moment.
 */
function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...options.env },
      cwd: options.cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (e) => reject(new Error(`${command}: ${e.message}`)));
    child.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `${command} exited ${code}${stderr ? `: ${stderr.trim().slice(0, 2000)}` : ""}`
        )
      );
    });
  });
}

function archiveName(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${ARCHIVE_PREFIX}${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(
    at.getDate()
  )}-${p(at.getHours())}${p(at.getMinutes())}${ARCHIVE_SUFFIX}`;
}

function databaseNameFrom(url: string): string {
  try {
    return new URL(url).pathname.replace(/^\//, "") || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Take a backup (§13.1).
 *
 * Writes a `BackupRun` row in BOTH the success and failure cases. A failed
 * backup that leaves no trace is the worst of both worlds: nothing to restore
 * from, and nothing to tell you so. The staleness alert reads `succeeded`, so
 * a run of failures escalates exactly like no runs at all.
 */
export async function runBackup(): Promise<{
  ok: boolean;
  fileName?: string;
  sizeBytes?: number;
  error?: string;
}> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new AppError("VALIDATION_FAILED", "DATABASE_URL is not set.");
  }

  const startedAt = new Date();
  const runRow = await prisma.backupRun.create({
    data: { startedAt, succeeded: false },
  });

  const fileName = archiveName(startedAt);
  const finalPath = path.join(BACKUP_ROOT, fileName);
  const stageDir = path.join(BACKUP_ROOT, `.staging-${runRow.id}`);

  try {
    await fs.mkdir(BACKUP_ROOT, { recursive: true });
    await fs.mkdir(stageDir, { recursive: true });

    // 1. The database, in pg_dump's custom format so pg_restore can be
    //    selective and --clean --if-exists works on restore.
    const dumpPath = path.join(stageDir, "database.dump");
    await run("pg_dump", ["--format=custom", "--file", dumpPath, databaseUrl]);

    // 2. The data directory — attendance photos, receipts and prize images. The
    //    whole root is archived rather than a list of known subdirectories, so
    //    adding an image type needs no change here (D-118). It may legitimately
    //    not exist yet on a fresh install; an empty tar is correct there, and is
    //    better than skipping the entry and making restore.sh handle two shapes.
    const { DATA_ROOT } = await import("@/server/services/attendance-photo");
    const dataTarPath = path.join(stageDir, "data.tar.gz");
    const dataExists = existsSync(DATA_ROOT);
    await run("tar", [
      "-czf",
      dataTarPath,
      "-C",
      dataExists ? DATA_ROOT : stageDir,
      ...(dataExists ? ["."] : ["--files-from", "/dev/null"]),
    ]);

    // 3. The manifest — what makes a restore verifiable rather than hopeful.
    const [dumpStat, dataStat] = await Promise.all([
      fs.stat(dumpPath),
      fs.stat(dataTarPath),
    ]);
    const manifest: BackupManifest = {
      formatVersion: 1,
      appVersion: process.env.npm_package_version ?? "unknown",
      schemaMigration: await currentMigrationName(),
      createdAt: startedAt.toISOString(),
      databaseName: databaseNameFrom(databaseUrl),
      tableCounts: await tableRowCounts(),
      totalRows: 0,
      files: [
        {
          name: "database.dump",
          sha256: await sha256File(dumpPath),
          sizeBytes: dumpStat.size,
        },
        {
          name: "data.tar.gz",
          sha256: await sha256File(dataTarPath),
          sizeBytes: dataStat.size,
        },
      ],
    };
    manifest.totalRows = manifest.tableCounts.reduce((s, t) => s + t.rows, 0);
    await fs.writeFile(
      path.join(stageDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );

    // Pack all three. `-C stageDir .` keeps the archive flat — restore.sh
    // expects manifest.json at the top level, not under a staging path that
    // carries a run id nobody can predict.
    await run("tar", ["-czf", finalPath, "-C", stageDir, "."]);

    const checksum = await sha256File(finalPath);
    await fs.writeFile(
      `${finalPath}.sha256`,
      `${checksum}  ${fileName}\n`,
      "utf8"
    );

    const finalStat = await fs.stat(finalPath);
    await prisma.backupRun.update({
      where: { id: runRow.id },
      data: {
        finishedAt: new Date(),
        succeeded: true,
        sizeBytes: BigInt(finalStat.size),
        filePath: finalPath,
        checksum,
      },
    });

    return { ok: true, fileName, sizeBytes: finalStat.size };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await prisma.backupRun.update({
      where: { id: runRow.id },
      data: { finishedAt: new Date(), succeeded: false, errorText: error },
    });
    // Remove a half-written archive so it can never be mistaken for a good one.
    await fs.rm(finalPath, { force: true }).catch(() => {});
    await fs.rm(`${finalPath}.sha256`, { force: true }).catch(() => {});
    return { ok: false, error };
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Archives on disk, newest first. The disk is the truth, not `BackupRun`. */
export async function listArchives(): Promise<BackupArchive[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(BACKUP_ROOT);
  } catch {
    return [];
  }

  const archives: BackupArchive[] = [];
  for (const name of entries) {
    if (!name.startsWith(ARCHIVE_PREFIX) || !name.endsWith(ARCHIVE_SUFFIX))
      continue;
    const filePath = path.join(BACKUP_ROOT, name);
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      archives.push({
        fileName: name,
        filePath,
        sizeBytes: stat.size,
        createdAt: stat.mtime,
      });
    } catch {
      // Vanished between readdir and stat. Not an error worth failing over.
    }
  }

  return archives.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/**
 * §13.2's retention, and the guard that makes it safe.
 *
 * Keeps the newest `BACKUP_KEEP_COUNT` archives — but deletes NOTHING unless
 * at least `MIN_SURVIVING_BACKUPS` would remain afterwards. "Never delete your
 * way to zero" is a literal requirement, and it is what stops a bug in the
 * naming or sorting logic from clearing the shelf.
 *
 * The `.sha256` sidecar is removed with its archive; an orphaned checksum for a
 * file that no longer exists reads, at a glance, as a backup you still have.
 */
export async function applyRetention(
  keep: number = BACKUP_KEEP_COUNT
): Promise<{ deleted: string[]; kept: number; skippedForSafety: boolean }> {
  const archives = await listArchives();

  const doomed = archives.slice(keep);
  if (doomed.length === 0) {
    return { deleted: [], kept: archives.length, skippedForSafety: false };
  }

  const surviving = archives.length - doomed.length;
  if (surviving < MIN_SURVIVING_BACKUPS) {
    return {
      deleted: [],
      kept: archives.length,
      skippedForSafety: true,
    };
  }

  const deleted: string[] = [];
  for (const archive of doomed) {
    try {
      await fs.rm(archive.filePath, { force: true });
      await fs.rm(`${archive.filePath}.sha256`, { force: true });
      deleted.push(archive.fileName);
    } catch {
      // Leaving an old archive behind is harmless; failing the whole job is not.
    }
  }

  return { deleted, kept: archives.length - deleted.length, skippedForSafety: false };
}

export type OffsiteLevel = "green" | "amber" | "red";

export type BackupStatus = {
  lastLocalBackupAt: Date | null;
  lastLocalBackupSucceeded: boolean;
  localBackupIsStale: boolean;
  lastOffsiteCopyAt: Date | null;
  lastOffsiteFileName: string | null;
  offsiteLevel: OffsiteLevel;
  offsiteDaysAgo: number | null;
  archiveCount: number;
  latestArchive: BackupArchive | null;
  message: string | null;
};

async function readOffsiteRecord(): Promise<{
  at: Date | null;
  fileName: string | null;
}> {
  const row = await prisma.appSetting.findUnique({
    where: { key: LAST_OFFSITE_COPY_KEY },
  });
  const value = row?.value as
    | { copiedAt?: string; fileName?: string }
    | null
    | undefined;

  const parsed = value?.copiedAt ? new Date(value.copiedAt) : null;
  return {
    at: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
    fileName: value?.fileName ?? null,
  };
}

/**
 * §13.4's escalation, in one place so the dashboard, the settings screen and
 * the health endpoint cannot disagree about how bad things are.
 *
 * green < 7 days · amber at 7 · red at 14, and red is undismissable in the UI.
 *
 * A business that has NEVER copied a backup off-machine is treated as red
 * rather than green. "No data yet" is not reassurance here — it is the worst
 * case, and the one a new install is actually in.
 */
export function offsiteLevelFor(
  lastOffsiteCopyAt: Date | null,
  now: Date = new Date()
): { level: OffsiteLevel; daysAgo: number | null } {
  if (!lastOffsiteCopyAt) return { level: "red", daysAgo: null };

  const daysAgo = Math.floor(
    (now.getTime() - lastOffsiteCopyAt.getTime()) / 86_400_000
  );

  if (daysAgo >= OFFSITE_RED_DAYS) return { level: "red", daysAgo };
  if (daysAgo >= OFFSITE_AMBER_DAYS) return { level: "amber", daysAgo };
  return { level: "green", daysAgo };
}

/**
 * §13.4's plain-language warning. It names what is actually lost, in units the
 * owner cares about, because "backup stale" does not make anyone act.
 */
export function offsiteMessageFor(
  level: OffsiteLevel,
  daysAgo: number | null
): string | null {
  if (level === "green") return null;

  if (daysAgo === null) {
    return (
      "You have never copied a backup off this machine. If this computer " +
      "fails today you lose every sale, customer balance and attendance " +
      "record the business has."
    );
  }

  const window = `${daysAgo} day${daysAgo === 1 ? "" : "s"}`;
  return (
    `Your last off-machine backup was ${window} ago. If this computer fails ` +
    `today you lose ${window} of sales, customer balances and attendance records.`
  );
}

export async function getBackupStatus(now: Date = new Date()): Promise<BackupStatus> {
  const [lastSuccessful, lastAny, offsite, archives] = await Promise.all([
    prisma.backupRun.findFirst({
      where: { succeeded: true },
      orderBy: { startedAt: "desc" },
    }),
    prisma.backupRun.findFirst({ orderBy: { startedAt: "desc" } }),
    readOffsiteRecord(),
    listArchives(),
  ]);

  const lastLocalBackupAt = lastSuccessful?.finishedAt ?? lastSuccessful?.startedAt ?? null;
  const { level, daysAgo } = offsiteLevelFor(offsite.at, now);

  return {
    lastLocalBackupAt,
    lastLocalBackupSucceeded: Boolean(lastAny?.succeeded),
    localBackupIsStale:
      !lastLocalBackupAt ||
      now.getTime() - lastLocalBackupAt.getTime() >
        LOCAL_BACKUP_STALE_HOURS * 3_600_000,
    lastOffsiteCopyAt: offsite.at,
    lastOffsiteFileName: offsite.fileName,
    offsiteLevel: level,
    offsiteDaysAgo: daysAgo,
    archiveCount: archives.length,
    latestArchive: archives[0] ?? null,
    message: offsiteMessageFor(level, daysAgo),
  };
}

/**
 * §13.4's copy log. An honour-system button — its job is to drive the reminder,
 * not to prove anything. Audit-logged so "I definitely copied it" is checkable
 * later against who tapped it and when.
 */
export async function recordOffsiteCopy(
  actor: Actor,
  fileName: string | null,
  meta: { ipAddress?: string | null } = {}
): Promise<{ copiedAt: Date; fileName: string | null }> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can record an off-machine backup copy.");
  }

  // Record the real archive name rather than trusting the client's. The button
  // is next to the download, but a stale tab could name an archive that
  // retention has since deleted — and the copy log is evidence.
  const archives = await listArchives();
  const resolved =
    (fileName && archives.find((a) => a.fileName === fileName)?.fileName) ??
    archives[0]?.fileName ??
    null;

  if (!resolved) {
    throw new AppError(
      "VALIDATION_FAILED",
      "There is no backup archive to copy yet. Take a backup first."
    );
  }

  const copiedAt = new Date();
  const previous = await readOffsiteRecord();

  await prisma.$transaction(async (tx) => {
    await tx.appSetting.upsert({
      where: { key: LAST_OFFSITE_COPY_KEY },
      update: { value: { copiedAt: copiedAt.toISOString(), fileName: resolved } },
      create: {
        key: LAST_OFFSITE_COPY_KEY,
        value: { copiedAt: copiedAt.toISOString(), fileName: resolved },
      },
    });
    await writeAudit(
      actor,
      {
        entity: "AppSetting",
        entityId: LAST_OFFSITE_COPY_KEY,
        action: "UPDATE",
        before: {
          copiedAt: previous.at?.toISOString() ?? null,
          fileName: previous.fileName,
        },
        after: { copiedAt: copiedAt.toISOString(), fileName: resolved },
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );
  });

  return { copiedAt, fileName: resolved };
}

/**
 * Resolve an archive for download, refusing anything that is not a plain
 * archive name in BACKUP_ROOT.
 *
 * A backup contains password hashes, customer names and phone numbers, so this
 * is the one place a path from a URL could turn into "read any file on the
 * server". The name is matched against the actual directory listing rather
 * than sanitised — a listing cannot be traversed out of.
 */
export async function resolveArchiveForDownload(
  actor: Actor,
  fileName?: string | null
): Promise<BackupArchive> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can download a backup.");
  }

  const archives = await listArchives();
  const newest = archives[0];
  if (!newest) {
    throw new AppError("NOT_FOUND", "No backup archive exists yet.");
  }

  if (!fileName) return newest;

  const match = archives.find((a) => a.fileName === fileName);
  if (!match) throw new AppError("NOT_FOUND", "That backup archive does not exist.");
  return match;
}

/** Recent runs for the owner's backup screen. */
export async function listBackupRuns(actor: Actor, take = 20) {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can view backup history.");
  }
  return prisma.backupRun.findMany({
    orderBy: { startedAt: "desc" },
    take,
  });
}

/**
 * Owner-triggered backup (§13.2: "plus on demand from the owner's Backup
 * screen"), followed by retention so the on-demand path cannot grow the
 * directory without bound either.
 */
export async function runBackupNow(actor: Actor) {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can take a backup.");
  }
  const result = await runBackup();
  if (!result.ok) {
    throw new AppError("INTERNAL", result.error ?? "The backup failed.");
  }
  const retention = await applyRetention();
  return { ...result, retention };
}
