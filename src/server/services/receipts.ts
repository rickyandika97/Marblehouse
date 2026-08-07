/**
 * Expense receipt storage (PRD §4.12, §7.6).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A receipt is NOT watermarked. This is deliberate.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `attendance-photo.ts` burns time, place and person into every image because
 * an attendance photo is evidence about *a person being somewhere at a time*,
 * and the whole control depends on that being unforgeable.
 *
 * A receipt is evidence of *a purchase*. The proof is the printed document
 * itself — its own date, vendor and total. Stamping our server clock across it
 * would obscure the very details that make it evidence, and would imply we had
 * verified something we had not: we know when the photo was uploaded, not when
 * the money was spent.
 *
 * So this module reuses the storage SHAPE — same data root, same
 * `YYYY/MM/DD/<uuid>` layout, same traversal-safe resolver, same
 * authenticated-route-only access — and none of the watermarking.
 *
 * Files live under `data/receipts/YYYY/MM/DD/<uuid>.jpg`, never as bytes in
 * Postgres (§4.15's reasoning applies equally: it would bloat every backup).
 */
import { unlink } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AppError } from "@/server/errors";
import { DATA_ROOT } from "@/server/services/attendance-photo";

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/**
 * Wider than an attendance photo (1080px). A receipt is a document — the line
 * items and the total have to stay readable when the owner zooms in months
 * later to settle a query.
 */
const OUTPUT_WIDTH = 1600;

/**
 * Normalise and store one receipt image.
 *
 * Re-encoding through sharp is not cosmetic: it strips EXIF, which on a phone
 * photo carries the GPS coordinates of wherever it was taken. A receipt does
 * not need to record someone's home address, and §14's data-protection
 * position is easier to keep if we never store it.
 *
 * Returns the path RELATIVE to the data root — what goes in
 * `Expense.receiptPath`, keeping the database portable when the data directory
 * moves between machines.
 */
export async function storeReceipt(
  upload: ArrayBuffer,
  at: Date = new Date(),
): Promise<{ relativePath: string; absolutePath: string }> {
  if (upload.byteLength === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The receipt did not upload. Try again.",
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
  // is dropped — otherwise a portrait phone photo is stored on its side.
  const output = await input
    .rotate()
    .resize({ width: OUTPUT_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer();

  const yyyy = String(at.getUTCFullYear());
  const mm = String(at.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(at.getUTCDate()).padStart(2, "0");

  const relativeDir = path.join("receipts", yyyy, mm, dd);
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
 * Same reasoning as `resolvePhotoPath`: the value comes from our own database,
 * but this is the function the authenticated image route uses and a path check
 * at the point of file access is worth having regardless.
 */
export function resolveReceiptPath(relativePath: string): string {
  const absolute = path.resolve(DATA_ROOT, relativePath);
  const root = path.resolve(DATA_ROOT);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new AppError("VALIDATION_FAILED", "That is not a valid receipt path.");
  }
  return absolute;
}

/** Delete one stored receipt, ignoring a file that has already gone. */
export async function deleteReceipt(relativePath: string): Promise<void> {
  try {
    await unlink(resolveReceiptPath(relativePath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}
