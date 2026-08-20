/**
 * Prize catalog images (PRD §4.8, §7.4, §8.6).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A prize image is CATALOG DATA, not evidence. That drives every difference.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `attendance-photo.ts` watermarks and refuses gallery uploads, because an
 * attendance photo is evidence about a person being somewhere at a time.
 * `receipts.ts` drops the watermark but keeps the storage shape, because a
 * receipt is evidence of a purchase.
 *
 * This is neither. A prize photo is a picture of a teddy bear that helps staff
 * find the right box on the shelf (§8.6). So:
 *
 *  - **No watermark, no EXIF-freshness check.** A supplier's product shot
 *    pulled from a catalogue is a perfectly good prize image. Refusing gallery
 *    uploads here would block the normal case rather than catch a forgery.
 *  - **Replaceable.** Unlike an attendance photo, which is an immutable record,
 *    a prize image is a corrigible attribute — a better photo should simply
 *    replace the old one, and the old file is deleted rather than orphaned.
 *  - **Square, not wide.** §8.6 renders a card grid; a 600px square thumbnails
 *    predictably at every breakpoint. A receipt is 1600px wide because its line
 *    items must stay readable, which is not a concern for a photo of a toy.
 *
 * What it DOES keep from both: the same data root, the same
 * `YYYY/MM/DD/<uuid>` layout, the same traversal-safe resolver, the same
 * re-encode through sharp (which strips EXIF — a phone photo of a prize still
 * carries the GPS coordinates of the shop, and §14 is easier to keep if we
 * never store them), and the same rule that the file is served ONLY through an
 * authenticated route. Files live on disk, never as bytes in Postgres, because
 * §4.15's reasoning applies equally: it would bloat every backup.
 */
import { unlink } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AppError } from "@/server/errors";
import { DATA_ROOT } from "@/server/services/attendance-photo";

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Square, and smaller than a receipt's 1600px. §8.6's grid shows these as
 * cards on a tablet; 600px covers a 2x display at the size they actually
 * render, and keeps the data directory small when a catalogue runs to hundreds
 * of items.
 */
const OUTPUT_SIZE = 600;

/**
 * Normalise and store one prize image.
 *
 * Centre-cropped to a square rather than letterboxed: a grid of cards with
 * inconsistent aspect ratios reads as broken, and a centre crop of a product
 * shot almost always keeps the product. The crop is done explicitly rather
 * than with `fit: "cover"`, because that flag combined with
 * `withoutEnlargement` silently yields NON-square output for any source
 * shorter than 600px on either axis (D-118).
 *
 * Returns the path RELATIVE to the data root — what goes in
 * `PrizeItem.imagePath`, keeping the database portable when the data directory
 * moves between machines.
 */
export async function storePrizeImage(
  upload: ArrayBuffer,
  at: Date = new Date(),
): Promise<{ relativePath: string; absolutePath: string }> {
  if (upload.byteLength === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The image did not upload. Try again.",
    );
  }
  if (upload.byteLength > MAX_UPLOAD_BYTES) {
    throw new AppError("VALIDATION_FAILED", "That image is too large.");
  }

  const input = sharp(Buffer.from(upload), { failOn: "error" });

  try {
    await input.metadata();
  } catch {
    throw new AppError("VALIDATION_FAILED", "That file is not a usable image.");
  }

  // `.rotate()` with no argument applies the EXIF orientation before that data
  // is dropped — otherwise a portrait phone photo is stored on its side. It
  // must also come before measuring, or a portrait source is measured on its
  // side and cropped along the wrong axis.
  const upright = sharp(await input.rotate().toBuffer(), { failOn: "error" });
  const meta = await upright.metadata();

  // Crop to a centred square FIRST, then scale down. The obvious one-liner —
  // `resize({ width: 600, height: 600, fit: "cover", withoutEnlargement: true })`
  // — does NOT produce a square: `withoutEnlargement` clamps each axis to the
  // source independently, so 1600x400 comes out 600x400 and 300x900 comes out
  // 300x600. §8.6 renders a card grid, and a mixed-aspect grid reads as broken.
  // Measured, not assumed: the test asserts width === height for a wide source.
  const side = Math.min(meta.width ?? OUTPUT_SIZE, meta.height ?? OUTPUT_SIZE);

  const output = await upright
    .extract({
      left: Math.floor(((meta.width ?? side) - side) / 2),
      top: Math.floor(((meta.height ?? side) - side) / 2),
      width: side,
      height: side,
    })
    // Square in, square out. `withoutEnlargement` now only decides whether a
    // small photo is left at its own size rather than upscaled into blur.
    .resize({ width: OUTPUT_SIZE, height: OUTPUT_SIZE, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");

  const relativeDir = path.join("prizes", yyyy, mm, dd);
  // Global `crypto`, not `node:crypto` — the latter breaks the edge
  // instrumentation bundle (D-47).
  const fileName = `${crypto.randomUUID()}.jpg`;
  const absoluteDir = path.join(DATA_ROOT, relativeDir);

  await mkdir(absoluteDir, { recursive: true });
  const absolutePath = path.join(absoluteDir, fileName);
  await writeFile(absolutePath, output);

  return { relativePath: path.join(relativeDir, fileName), absolutePath };
}

/**
 * Resolve a stored relative path, refusing traversal.
 *
 * Same reasoning as `resolveReceiptPath`: the value comes from our own
 * database, but this is the function the authenticated image route uses, and a
 * path check at the point of file access is worth having regardless.
 */
export function resolvePrizeImagePath(relativePath: string): string {
  const absolute = path.resolve(DATA_ROOT, relativePath);
  const root = path.resolve(DATA_ROOT);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new AppError("VALIDATION_FAILED", "That is not a valid image path.");
  }
  return absolute;
}

/**
 * Delete one stored image, ignoring a file that has already gone.
 *
 * Called when an image is REPLACED as well as when it is removed — a prize
 * image is a corrigible attribute, not a record, so the superseded file has no
 * reason to stay on disk. This is why prize images need no retention job the
 * way attendance photos do (`photo-retention.ts`): nothing accumulates.
 */
export async function deletePrizeImage(relativePath: string): Promise<void> {
  try {
    await unlink(resolvePrizeImagePath(relativePath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}
