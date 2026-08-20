/**
 * Attendance photo retention (PRD §4.15, §11).
 *
 * The rule that must never break: **the photo goes, the record stays.** Losing
 * the image after 61 days is the policy; losing the lateness history with it
 * would destroy the only reason the record exists — and it would conveniently
 * erase the evidence for whatever wage dispute made someone want it gone.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { prisma, makeShop, uniq } from "./helpers";
import {
  purgeCutoff,
  purgeExpiredAttendancePhotos,
  RETENTION_DAYS,
} from "../photo-retention";
import {
  deleteAttendancePhoto,
  resolvePhotoPath,
  storeAttendancePhoto,
} from "../attendance-photo";

const shopIds: string[] = [];
const userIds: string[] = [];
const attendanceIds: string[] = [];
const photoPaths: string[] = [];

afterEach(async () => {
  await prisma.attendance.deleteMany({ where: { id: { in: attendanceIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  for (const p of photoPaths) await deleteAttendancePhoto(p).catch(() => {});
  attendanceIds.length = 0;
  photoPaths.length = 0;
  userIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const TODAY = new Date("2026-08-07T00:00:00.000Z");

/** An attendance row with a real watermarked file on disk. */
async function recordOn(businessDate: Date) {
  const shop = await makeShop(prisma, "Retention");
  shopIds.push(shop.id);

  const id = uniq();
  const user = await prisma.user.create({
    data: {
      email: `ret-${id}@marblehouse.invalid`,
      name: `Ret ${id}`,
      username: `ret-${id}`,
      displayName: `Ret ${id}`,
    },
    select: { id: true },
  });
  userIds.push(user.id);

  const buf = await sharp({
    create: { width: 320, height: 240, channels: 3, background: "#334455" },
  })
    .jpeg()
    .toBuffer();
  const stored = await storeAttendancePhoto(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    {
      capturedAt: businessDate,
      timezone: "Asia/Jakarta",
      shopName: shop.name,
      userName: "Ret",
      latitude: null,
      longitude: null,
      accuracyM: null,
      locationDenied: true,
    }
  );
  photoPaths.push(stored.relativePath);

  const row = await prisma.attendance.create({
    data: {
      userId: user.id,
      shopId: shop.id,
      businessDate,
      clockInAt: businessDate,
      isLate: true,
      lateMinutes: 17,
      status: "LATE",
      photoPath: stored.relativePath,
    },
    select: { id: true },
  });
  attendanceIds.push(row.id);

  return { id: row.id, absolutePath: stored.absolutePath, relativePath: stored.relativePath };
}

function daysBefore(days: number): Date {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
}

describe("retention window (§4.15)", () => {
  it("cuts off exactly 61 days back", () => {
    const cutoff = purgeCutoff(TODAY);
    expect(RETENTION_DAYS).toBe(61);
    expect(cutoff.toISOString().slice(0, 10)).toBe("2026-06-07");
  });
});

describe("purging (§4.15, §11)", () => {
  it("deletes the FILE but keeps the record and its lateness history", async () => {
    const old = await recordOn(daysBefore(90));
    expect(existsSync(old.absolutePath)).toBe(true);

    const result = await purgeExpiredAttendancePhotos(TODAY);
    expect(result.purged).toBeGreaterThanOrEqual(1);

    // The image is gone from disk...
    expect(existsSync(old.absolutePath)).toBe(false);

    // ...and the RECORD survives, with its lateness intact (§4.15).
    const row = await prisma.attendance.findUnique({
      where: { id: old.id },
      select: {
        photoPath: true,
        photoPurgedAt: true,
        isLate: true,
        lateMinutes: true,
        status: true,
      },
    });
    expect(row).not.toBeNull();
    expect(row?.photoPath).toBeNull();
    expect(row?.photoPurgedAt).not.toBeNull();
    expect(row?.isLate).toBe(true);
    expect(row?.lateMinutes).toBe(17);
    expect(row?.status).toBe("LATE");
  });

  it("leaves a photo inside the retention window alone", async () => {
    const recent = await recordOn(daysBefore(10));

    await purgeExpiredAttendancePhotos(TODAY);

    expect(existsSync(recent.absolutePath)).toBe(true);
    const row = await prisma.attendance.findUnique({
      where: { id: recent.id },
      select: { photoPath: true, photoPurgedAt: true },
    });
    expect(row?.photoPath).not.toBeNull();
    expect(row?.photoPurgedAt).toBeNull();
  });

  it("does not purge a record exactly at the boundary", async () => {
    // 61 days back is the cutoff itself, and the filter is `< cutoff`.
    const boundary = await recordOn(daysBefore(RETENTION_DAYS));

    await purgeExpiredAttendancePhotos(TODAY);

    expect(existsSync(boundary.absolutePath)).toBe(true);
  });

  it("purges one day past the boundary", async () => {
    const past = await recordOn(daysBefore(RETENTION_DAYS + 1));

    await purgeExpiredAttendancePhotos(TODAY);

    expect(existsSync(past.absolutePath)).toBe(false);
  });

  it("is safe to run twice — the second pass finds nothing", async () => {
    await recordOn(daysBefore(90));

    const first = await purgeExpiredAttendancePhotos(TODAY);
    expect(first.purged).toBeGreaterThanOrEqual(1);

    const second = await purgeExpiredAttendancePhotos(TODAY);
    // Already-purged rows have a null photoPath and are no longer selected.
    expect(second.scanned).toBe(0);
    expect(second.failed).toBe(0);
  });

  it("survives a file that has already vanished from disk", async () => {
    const old = await recordOn(daysBefore(90));

    // Simulate a half-finished earlier purge or a manual cleanup.
    await deleteAttendancePhoto(old.relativePath);
    expect(existsSync(resolvePhotoPath(old.relativePath))).toBe(false);

    const result = await purgeExpiredAttendancePhotos(TODAY);
    expect(result.failed).toBe(0);

    const row = await prisma.attendance.findUnique({
      where: { id: old.id },
      select: { photoPath: true, photoPurgedAt: true },
    });
    expect(row?.photoPath).toBeNull();
    expect(row?.photoPurgedAt).not.toBeNull();
  });
});
