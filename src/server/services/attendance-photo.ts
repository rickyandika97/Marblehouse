/**
 * Attendance photo storage and watermarking (PRD §4.13, §4.15).
 *
 * **The server burns the watermark, never the client.** A client-drawn stamp is
 * worth nothing — whoever controls the client controls what it says. Everything
 * in the watermark comes from the server's own clock, the session's user, and
 * the shop record; the only client-supplied values are the coordinates, and
 * those are labelled as reported rather than presented as verified.
 *
 * **The original is discarded.** §4.13 says only the watermarked version is
 * stored, so there is deliberately no code path that writes the uploaded bytes
 * to disk.
 *
 * Files live under `data/attendance/YYYY/MM/DD/<uuid>.jpg` — on disk, never as
 * bytes in Postgres (§4.15: it would bloat every backup). They are served only
 * through an authenticated route that re-checks role and shop access.
 */
import { existsSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import { AppError } from "@/server/errors";

/**
 * Where photos live. Bind-mounted in Docker; gitignored in dev.
 *
 * `.env` ships `DATA_DIR=/data`, which is the path INSIDE the container. On the
 * dev Mac that resolves to the filesystem root and `mkdir` fails with ENOENT —
 * found by the tests below rather than by a staff member failing to clock in.
 *
 * So an absolute `DATA_DIR` is honoured only when that directory ITSELF already
 * exists. Otherwise we fall back to `<repo>/data`, which is what the README and
 * `.gitignore` already describe for development.
 *
 * Testing the directory rather than its parent is the point: `/` exists on
 * macOS too, so a parent check would still hand back `/data` and fail at
 * `mkdir`. In Docker the Dockerfile creates `/data` at build time, so the
 * configured path is present and always wins in production.
 */
function resolveDataRoot(): string {
  const configured = process.env.DATA_DIR;
  const localDefault = path.join(process.cwd(), "data");
  if (!configured) return localDefault;
  if (!path.isAbsolute(configured))
    return path.resolve(process.cwd(), configured);

  return existsSync(configured) ? configured : localDefault;
}

export const DATA_ROOT = resolveDataRoot();

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;
const OUTPUT_WIDTH = 1080;

/**
 * §4.13's gallery-upload check.
 *
 * Reject when EXIF carries a `DateTimeOriginal` that is more than 10 minutes
 * old — that is a picture taken earlier and picked from the gallery.
 *
 * **A photo with NO EXIF date is accepted** (owner decision, 7 Aug 2026 —
 * BUILD-LOG D-44). The `getUserMedia` → canvas → blob path that §4.13 mandates
 * produces exactly that: a JPEG with no EXIF at all. Rejecting it would reject
 * nearly every genuine clock-in while stopping no realistic cheat, since anyone
 * deliberately uploading an old file can strip EXIF just as easily.
 */
export const EXIF_MAX_AGE_MS = 10 * 60 * 1000;

export function exifDateIsStale(
  exifDate: Date | null,
  now: Date = new Date(),
): boolean {
  if (!exifDate) return false; // no date → live capture → accept (D-44)
  return now.getTime() - exifDate.getTime() > EXIF_MAX_AGE_MS;
}

/** Parse EXIF `DateTimeOriginal` ("YYYY:MM:DD HH:MM:SS") from sharp metadata. */
export function parseExifDateTimeOriginal(
  exif: Buffer | undefined,
): Date | null {
  if (!exif) return null;

  // Read it out of the raw EXIF block rather than adding a parser dependency.
  // The format is fixed-width and unambiguous, so a targeted match is safer
  // than a loose one.
  const text = exif.toString("latin1");
  const match = text.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match;
  const parsed = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export interface WatermarkFacts {
  /** Server clock. Never a client-supplied time. */
  capturedAt: Date;
  timezone: string;
  shopName: string;
  userName: string;
  latitude: number | null;
  longitude: number | null;
  accuracyM: number | null;
  locationDenied: boolean;
}

/**
 * The lines burned into the image.
 *
 * §4.13 lists date, time, timezone, shop, user, lat/long and accuracy. When
 * location was denied the watermark must say `LOCATION UNAVAILABLE` — the
 * absence has to be visible on the photo itself, not merely a database flag,
 * or a printed copy loses the caveat.
 */
export function watermarkLines(facts: WatermarkFacts): string[] {
  const stamp = new Intl.DateTimeFormat("en-GB", {
    timeZone: facts.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(facts.capturedAt);

  const location =
    facts.locationDenied || facts.latitude === null || facts.longitude === null
      ? "LOCATION UNAVAILABLE"
      : `${facts.latitude.toFixed(5)}, ${facts.longitude.toFixed(5)}` +
        (facts.accuracyM !== null ? ` (±${facts.accuracyM}m)` : "");

  return [
    `${stamp} ${facts.timezone}`,
    `${facts.shopName} · ${facts.userName}`,
    location,
  ];
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Watermark and store one clock-in photo.
 *
 * Returns the path RELATIVE to the data root, which is what goes in
 * `Attendance.photoPath`. Storing a relative path keeps the database portable
 * when the data directory moves between the dev Mac and the Windows box.
 */
export async function storeAttendancePhoto(
  upload: ArrayBuffer,
  facts: WatermarkFacts,
): Promise<{ relativePath: string; absolutePath: string }> {
  if (upload.byteLength === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The photo did not upload. Try again.",
    );
  }
  if (upload.byteLength > MAX_UPLOAD_BYTES) {
    throw new AppError("VALIDATION_FAILED", "That photo is too large.");
  }

  const input = sharp(Buffer.from(upload), { failOn: "error" });

  let metadata: Metadata;
  try {
    metadata = await input.metadata();
  } catch {
    throw new AppError("VALIDATION_FAILED", "That file is not a usable photo.");
  }

  // §4.13's gallery check, with D-44's "no EXIF date means live capture".
  const exifDate = parseExifDateTimeOriginal(metadata.exif);
  if (exifDateIsStale(exifDate, facts.capturedAt)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "That photo was not taken just now. Use the camera to take a new one.",
    );
  }

  // Materialise the resize BEFORE measuring. `metadata()` on a pipeline that
  // has a pending `resize()` reports the SOURCE dimensions, not the result, so
  // measuring the pipeline gives the overlay the wrong size and `composite`
  // fails with "Image to composite must have same dimensions or smaller" for
  // any photo wider than OUTPUT_WIDTH. Real phone photos are always wider.
  const { data: resizedBytes, info } = await input
    .rotate()
    .resize({ width: OUTPUT_WIDTH, withoutEnlargement: true })
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;

  const lines = watermarkLines(facts);
  const fontSize = Math.max(16, Math.round(width / 34));
  const lineHeight = Math.round(fontSize * 1.35);
  const padding = Math.round(fontSize * 0.7);
  const bandHeight = lineHeight * lines.length + padding * 2;
  const bandTop = Math.max(0, height - bandHeight);

  // A dark band behind the text so it stays legible over a bright shop
  // background — a bare white string vanishes against a lit doorway.
  const svg = `<svg width="${width}" height="${height}">
    <rect x="0" y="${bandTop}" width="${width}" height="${bandHeight}" fill="rgba(0,0,0,0.62)"/>
    ${lines
      .map(
        (line, i) =>
          `<text x="${padding}" y="${bandTop + padding + lineHeight * (i + 1) - Math.round(fontSize * 0.3)}" ` +
          `font-family="DejaVu Sans, Helvetica, Arial, sans-serif" font-size="${fontSize}" ` +
          `fill="#ffffff">${escapeXml(line)}</text>`,
      )
      .join("\n    ")}
  </svg>`;

  const output = await sharp(resizedBytes)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  const at = facts.capturedAt;
  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");

  const relativeDir = path.join("attendance", yyyy, mm, dd);
  // `crypto` is a global in Node 22 (and everywhere else). Importing
  // `node:crypto` instead made webpack fail with UnhandledSchemeError while
  // building the edge instrumentation bundle, which does not support `node:`
  // schemes — and instrumentation reaches this module through the scheduler.
  const fileName = `${crypto.randomUUID()}.jpg`;
  const absoluteDir = path.join(DATA_ROOT, relativeDir);

  await mkdir(absoluteDir, { recursive: true });
  const absolutePath = path.join(absoluteDir, fileName);
  await writeFile(absolutePath, output);

  // The uploaded original is never written anywhere (§4.13).
  return { relativePath: path.join(relativeDir, fileName), absolutePath };
}

/**
 * Resolve a stored relative path to an absolute one, refusing traversal.
 *
 * `photoPath` comes from our own database, but this is the function the
 * authenticated image route uses, and a path check at the point of file access
 * is worth having regardless of how trusted the input is believed to be.
 */
export function resolvePhotoPath(relativePath: string): string {
  const absolute = path.resolve(DATA_ROOT, relativePath);
  const root = path.resolve(DATA_ROOT);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new AppError("VALIDATION_FAILED", "That is not a valid photo path.");
  }
  return absolute;
}

/** Delete one stored photo, ignoring a file that has already gone (§4.15). */
export async function deleteAttendancePhoto(
  relativePath: string,
): Promise<void> {
  try {
    await unlink(resolvePhotoPath(relativePath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}
