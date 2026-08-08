/**
 * Backup, retention and the off-machine escalation (PRD §13, §16 Phase 9).
 *
 * What is worth proving here rather than assuming:
 *
 *  - **Retention never deletes its way to zero** (§13.2). This is the one that
 *    would be catastrophic and silent: a bug in the sort or the keep count
 *    could clear the shelf, and you would only find out on the day you needed
 *    an archive. Both branches are tested — it prunes when it safely can, and
 *    refuses when it cannot.
 *  - **The escalation boundaries** (§13.4): green under 7 days, amber at
 *    exactly 7, red at exactly 14, and red when there is NO record at all. The
 *    inclusive boundaries are the easy thing to get wrong by one day, and "no
 *    copy ever" reading as green would be the worst possible default.
 *  - **The red message names the actual loss**, because §13.4's whole argument
 *    is that a vague warning does not make anyone act.
 *  - **Idempotency-key cleanup respects the 24 h TTL** (D-16, §11). Deleting a
 *    key too early turns a double-tap back into a double sale, which is the
 *    one thing the mechanism exists to prevent.
 *
 * Retention is tested against a REAL temporary directory rather than a mocked
 * filesystem: the function's whole job is deciding which files to unlink, and a
 * mock would prove only that the mock was called.
 */
import { describe, expect, it, afterEach, afterAll, beforeEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prisma, uniq } from "./helpers";
import {
  BACKUP_KEEP_COUNT,
  MIN_SURVIVING_BACKUPS,
  offsiteLevelFor,
  offsiteMessageFor,
  tableRowCounts,
} from "../backup";
import { cleanupExpiredData, IDEMPOTENCY_KEY_TTL_HOURS } from "../maintenance";

// ─────────────────────────────────────────────────────────────────────────
// Retention (§13.2)
// ─────────────────────────────────────────────────────────────────────────
//
// **These call the REAL `applyRetention`.** An earlier version of this file
// re-implemented the keep/delete decision locally against a temp directory,
// and it was worthless: deleting the safety floor from the shipped function
// left all 13 tests green. That is D-62's lesson exactly — a test that
// reproduces the logic tests the reproduction.
//
// `BACKUP_ROOT` is resolved once at module load from `BACKUP_DIR`, so the env
// var is set to a temp directory and the module is imported FRESH per test via
// `vi.resetModules()`. That is the whole reason for the dynamic import below.

async function seedArchives(dir: string, count: number): Promise<string[]> {
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const name = `marblehouse-2026-08-${String(i + 1).padStart(2, "0")}-0200.tar.gz`;
    const file = path.join(dir, name);
    await fs.writeFile(file, `archive ${i}`);
    // Distinct mtimes so "newest first" is unambiguous.
    const when = new Date(Date.UTC(2026, 7, i + 1, 2, 0, 0));
    await fs.utimes(file, when, when);
    await fs.writeFile(`${file}.sha256`, `deadbeef  ${name}\n`);
    names.push(name);
  }
  return names;
}

/** Load `backup.ts` fresh with BACKUP_ROOT pointed at `dir`. */
async function retentionModuleFor(dir: string) {
  process.env.BACKUP_DIR = dir;
  vi.resetModules();
  return import("../backup");
}

describe("backup retention (§13.2)", () => {
  let dir: string;
  const originalBackupDir = process.env.BACKUP_DIR;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "mh-retention-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    if (originalBackupDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = originalBackupDir;
    vi.resetModules();
  });

  it("keeps the newest 7 and prunes the rest", async () => {
    const names = await seedArchives(dir, 10);
    const { applyRetention } = await retentionModuleFor(dir);

    const result = await applyRetention();

    expect(result.skippedForSafety).toBe(false);
    expect(result.kept).toBe(BACKUP_KEEP_COUNT);
    // The three OLDEST are the ones removed — not the three newest.
    expect(result.deleted.sort()).toEqual([names[0], names[1], names[2]].sort());
    // And they are really gone from disk.
    await expect(fs.stat(path.join(dir, names[0]!))).rejects.toThrow();
    await expect(fs.stat(path.join(dir, names[9]!))).resolves.toBeTruthy();
  });

  it("deletes nothing when there are 7 or fewer", async () => {
    await seedArchives(dir, BACKUP_KEEP_COUNT);
    const { applyRetention } = await retentionModuleFor(dir);

    const result = await applyRetention();

    expect(result.deleted).toHaveLength(0);
    expect(result.skippedForSafety).toBe(false);
    expect(result.kept).toBe(BACKUP_KEEP_COUNT);
  });

  it("NEVER deletes its way below the safety floor", async () => {
    // The dangerous case: a keep count of 1 against 4 archives would leave 1,
    // below MIN_SURVIVING_BACKUPS of 3. Retention must refuse entirely.
    const names = await seedArchives(dir, 4);
    const { applyRetention } = await retentionModuleFor(dir);

    const result = await applyRetention(1);

    expect(result.skippedForSafety).toBe(true);
    expect(result.deleted).toHaveLength(0);
    expect(result.kept).toBe(4);
    // Every archive still on disk — this is the assertion that matters.
    for (const name of names) {
      await expect(fs.stat(path.join(dir, name))).resolves.toBeTruthy();
    }
    expect(MIN_SURVIVING_BACKUPS).toBeGreaterThan(1);
  });

  it("removes the .sha256 sidecar with its archive", async () => {
    const names = await seedArchives(dir, 10);
    const { applyRetention } = await retentionModuleFor(dir);

    await applyRetention();

    // An orphaned checksum reads at a glance as a backup you still have.
    await expect(fs.stat(path.join(dir, `${names[0]}.sha256`))).rejects.toThrow();
    await expect(
      fs.stat(path.join(dir, `${names[9]}.sha256`))
    ).resolves.toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// §13.4's escalation ladder
// ─────────────────────────────────────────────────────────────────────────

describe("off-machine copy escalation (§13.4)", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it("is RED when a backup has never been copied off-machine", () => {
    // "No data yet" is the worst case, not a neutral one — it is the state
    // every new install is in.
    const { level, daysAgo: d } = offsiteLevelFor(null, now);
    expect(level).toBe("red");
    expect(d).toBeNull();
  });

  it("is green below 7 days", () => {
    expect(offsiteLevelFor(daysAgo(0), now).level).toBe("green");
    expect(offsiteLevelFor(daysAgo(6), now).level).toBe("green");
  });

  it("turns amber at exactly 7 days, not 8", () => {
    expect(offsiteLevelFor(daysAgo(6), now).level).toBe("green");
    expect(offsiteLevelFor(daysAgo(7), now).level).toBe("amber");
  });

  it("turns red at exactly 14 days, not 15", () => {
    expect(offsiteLevelFor(daysAgo(13), now).level).toBe("amber");
    expect(offsiteLevelFor(daysAgo(14), now).level).toBe("red");
  });

  it("names the actual loss in the red message", () => {
    const message = offsiteMessageFor("red", 16);
    // §13.4 is explicit that the warning must state what is lost, in days,
    // in plain language. A vague "backup overdue" does not make anyone act.
    expect(message).toContain("16 days");
    expect(message).toContain("sales");
    expect(message).toContain("customer balances");
    expect(message).toContain("attendance records");
  });

  it("says nothing when green", () => {
    expect(offsiteMessageFor("green", 2)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Manifest row counts (§13.1) — what a restore is verified against
// ─────────────────────────────────────────────────────────────────────────

describe("manifest row counts (§13.1)", () => {
  it("counts every public table and excludes Prisma's own", async () => {
    const counts = await tableRowCounts();
    const names = counts.map((c) => c.table);

    expect(names).toContain("Sale");
    expect(names).toContain("Customer");
    expect(names).toContain("AuditLog");
    // A migration table in the manifest would make every restore mismatch.
    expect(names.some((n) => n.startsWith("_prisma"))).toBe(false);
    // Exact counts, never the stats collector's estimate.
    expect(counts.every((c) => Number.isInteger(c.rows))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Idempotency-key cleanup (§11, closes D-16)
// ─────────────────────────────────────────────────────────────────────────

describe("expired data cleanup (§11)", () => {
  const created: string[] = [];

  afterEach(async () => {
    await prisma.idempotencyKey.deleteMany({ where: { key: { in: created } } });
    created.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reclaims keys past the TTL and KEEPS those inside it", async () => {
    const stale = `p9-stale-${uniq()}`;
    const fresh = `p9-fresh-${uniq()}`;
    created.push(stale, fresh);

    await prisma.idempotencyKey.create({
      data: {
        key: stale,
        userId: "test",
        endpoint: "/test",
        responseJson: {},
        createdAt: new Date(
          Date.now() - (IDEMPOTENCY_KEY_TTL_HOURS + 1) * 3_600_000
        ),
      },
    });
    await prisma.idempotencyKey.create({
      data: { key: fresh, userId: "test", endpoint: "/test", responseJson: {} },
    });

    await cleanupExpiredData();

    expect(await prisma.idempotencyKey.findUnique({ where: { key: stale } })).toBeNull();
    // The fresh key MUST survive: deleting a key a client might still replay
    // turns a double-tap back into a double sale (NF-5, R-3).
    expect(
      await prisma.idempotencyKey.findUnique({ where: { key: fresh } })
    ).not.toBeNull();
  });

  it("keeps a key that is just inside the TTL", async () => {
    const key = `p9-edge-${uniq()}`;
    created.push(key);

    await prisma.idempotencyKey.create({
      data: {
        key,
        userId: "test",
        endpoint: "/test",
        responseJson: {},
        createdAt: new Date(
          Date.now() - (IDEMPOTENCY_KEY_TTL_HOURS - 1) * 3_600_000
        ),
      },
    });

    await cleanupExpiredData();
    expect(await prisma.idempotencyKey.findUnique({ where: { key } })).not.toBeNull();
  });
});
