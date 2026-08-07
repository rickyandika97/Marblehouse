/**
 * Attendance photo pipeline (PRD §4.13, §4.15).
 *
 * Two things are worth proving here rather than assuming:
 *
 * 1. **The EXIF rule behaves as D-44 decided.** A photo with no EXIF date is
 *    the normal live-capture case and must be accepted; only a date that is
 *    present AND stale is a gallery upload. Getting this backwards locks every
 *    staff member out of clocking in, which is a worse failure than the cheat
 *    it would prevent.
 *
 * 2. **The watermark really renders.** These run sharp for real against a
 *    generated image, because "the pipeline throws on this input" is the kind
 *    of thing that only shows up when a real photo arrives.
 */
import { describe, expect, it, afterAll } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import {
  DATA_ROOT,
  exifDateIsStale,
  parseExifDateTimeOriginal,
  resolvePhotoPath,
  storeAttendancePhoto,
  watermarkLines,
  deleteAttendancePhoto,
} from "../attendance-photo";

const written: string[] = [];

afterAll(async () => {
  for (const p of written) await deleteAttendancePhoto(p).catch(() => {});
});

/** A plain JPEG with no EXIF — exactly what getUserMedia → canvas produces. */
async function livePhoto(): Promise<ArrayBuffer> {
  const buf = await sharp({
    create: { width: 640, height: 480, channels: 3, background: "#4a7fb5" },
  })
    .jpeg()
    .toBuffer();
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

const FACTS = {
  capturedAt: new Date("2026-08-07T02:15:00.000Z"),
  timezone: "Asia/Jakarta",
  shopName: "Branch 1",
  userName: "Siti",
  latitude: -6.20876,
  longitude: 106.84559,
  accuracyM: 12,
  locationDenied: false,
};

describe("EXIF gallery-upload check (§4.13, D-44)", () => {
  const now = new Date("2026-08-07T10:00:00.000Z");

  it("ACCEPTS a photo with no EXIF date — the normal live capture", () => {
    expect(exifDateIsStale(null, now)).toBe(false);
  });

  it("accepts an EXIF date from just now", () => {
    expect(exifDateIsStale(new Date(now.getTime() - 30_000), now)).toBe(false);
  });

  it("accepts an EXIF date exactly at the 10-minute limit", () => {
    expect(exifDateIsStale(new Date(now.getTime() - 10 * 60_000), now)).toBe(
      false,
    );
  });

  it("REJECTS an EXIF date older than 10 minutes — a gallery pick", () => {
    expect(
      exifDateIsStale(new Date(now.getTime() - 10 * 60_000 - 1000), now),
    ).toBe(true);
  });

  it("rejects a photo taken yesterday", () => {
    expect(exifDateIsStale(new Date(now.getTime() - 26 * 3600_000), now)).toBe(
      true,
    );
  });

  it("parses a DateTimeOriginal out of an EXIF block", () => {
    const exif = Buffer.from(
      "Exif\0\0...DateTimeOriginal2026:08:07 09:55:00\0",
      "latin1",
    );
    const parsed = parseExifDateTimeOriginal(exif);
    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(7); // August, zero-indexed
    expect(parsed?.getDate()).toBe(7);
  });

  it("returns null when there is no EXIF at all", () => {
    expect(parseExifDateTimeOriginal(undefined)).toBeNull();
  });
});

describe("watermark contents (§4.13)", () => {
  it("carries the time, timezone, shop, user and coordinates", () => {
    const lines = watermarkLines(FACTS);
    const all = lines.join(" | ");

    expect(all).toContain("Asia/Jakarta");
    expect(all).toContain("Branch 1");
    expect(all).toContain("Siti");
    expect(all).toContain("-6.20876");
    expect(all).toContain("106.84559");
    expect(all).toContain("±12m");
  });

  it("says LOCATION UNAVAILABLE when location was denied", () => {
    const lines = watermarkLines({ ...FACTS, locationDenied: true });
    const all = lines.join(" | ");

    // §4.13: the absence must be visible ON THE PHOTO, not only in a column.
    expect(all).toContain("LOCATION UNAVAILABLE");
    expect(all).not.toContain("106.84559");
  });

  it("says LOCATION UNAVAILABLE when coordinates are simply missing", () => {
    const lines = watermarkLines({ ...FACTS, latitude: null, longitude: null });
    expect(lines.join(" | ")).toContain("LOCATION UNAVAILABLE");
  });

  it("renders the shop's local time, not UTC", () => {
    // 02:15 UTC is 09:15 in Jakarta (+7).
    expect(watermarkLines(FACTS)[0]).toContain("09:15");
  });
});

describe("storing a photo (§4.15)", () => {
  it("writes a watermarked JPEG under attendance/YYYY/MM/DD", async () => {
    const { relativePath, absolutePath } = await storeAttendancePhoto(
      await livePhoto(),
      FACTS,
    );
    written.push(relativePath);

    expect(relativePath).toMatch(
      /^attendance[/\\]2026[/\\]08[/\\]07[/\\][0-9a-f-]+\.jpg$/,
    );

    // It is a real, readable JPEG — not a zero-byte file.
    const bytes = await readFile(absolutePath);
    expect(bytes.byteLength).toBeGreaterThan(1000);

    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeGreaterThan(0);
  });

  it("accepts a live-capture photo that carries no EXIF at all", async () => {
    // The whole point of D-44: this is the ordinary case and must not throw.
    const { relativePath } = await storeAttendancePhoto(
      await livePhoto(),
      FACTS,
    );
    written.push(relativePath);
    expect(relativePath).toContain("attendance");
  });

  it("watermarks a photo WIDER than the output width", async () => {
    // Regression: `metadata()` on a pipeline with a pending resize reports the
    // SOURCE dimensions, so the overlay was built at 1200px for an image that
    // had been resized to 1080 and sharp refused to composite it. Every real
    // phone photo is wider than 1080, so this was the common case — the 640px
    // fixtures above never reached it.
    const wide = await sharp({
      create: { width: 3024, height: 4032, channels: 3, background: "#8899aa" },
    })
      .jpeg()
      .toBuffer();
    const ab = wide.buffer.slice(
      wide.byteOffset,
      wide.byteOffset + wide.byteLength,
    ) as ArrayBuffer;

    const { relativePath, absolutePath } = await storeAttendancePhoto(
      ab,
      FACTS,
    );
    written.push(relativePath);

    const meta = await sharp(await readFile(absolutePath)).metadata();
    expect(meta.width).toBe(1080);
    // Portrait aspect preserved: 4032/3024 × 1080 = 1440.
    expect(meta.height).toBe(1440);
  });

  it("refuses an empty upload", async () => {
    await expect(
      storeAttendancePhoto(new ArrayBuffer(0), FACTS),
    ).rejects.toThrow(/did not upload/i);
  });

  it("refuses a file that is not an image", async () => {
    const notAnImage = new TextEncoder().encode("this is not a jpeg").buffer;
    await expect(
      storeAttendancePhoto(notAnImage as ArrayBuffer, FACTS),
    ).rejects.toThrow(/not a usable photo/i);
  });
});

describe("path handling", () => {
  it("resolves a stored relative path inside the data root", () => {
    const resolved = resolvePhotoPath("attendance/2026/08/07/abc.jpg");
    expect(resolved.startsWith(path.resolve(DATA_ROOT))).toBe(true);
  });

  it("refuses a traversal attempt", () => {
    expect(() => resolvePhotoPath("../../etc/passwd")).toThrow(
      /not a valid photo path/i,
    );
  });
});
