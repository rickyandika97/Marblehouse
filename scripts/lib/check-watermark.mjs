/**
 * Is the watermark band actually burned into the pixels?
 *
 * `verify-phase6.sh` cannot ask this inline: a `node -e` with braces nested
 * inside a `chk "..."` argument gets mangled by the shell before node sees it,
 * and a crashing check reads as a pass (BUILD-LOG D-43, and again in Phase 6).
 * Keeping the logic in a real file is the fix for that whole class of bug.
 *
 * The band is a dark strip across the bottom of the image. Compare the bottom
 * 12% with a same-sized strip from the middle on two signals:
 *
 *   - **mean brightness** — the band is a dark overlay, so it is much darker;
 *   - **standard deviation** — text creates variance, and a flat backdrop has
 *     almost none. This is the stronger signal: it holds even if a photo's
 *     background happens to be dark already.
 *
 * **The crop must be materialised before it is measured.** Calling `.stats()`
 * on a pipeline with a pending `.extract()` returns stats for the WHOLE image,
 * so every region reads identically and the check silently proves nothing.
 * That is the same sharp pitfall that produced the composite bug in
 * `attendance-photo.ts` — measure a buffer, never a pipeline.
 *
 * Prints `burned` or `missing`. Exits non-zero on any failure so the caller
 * cannot mistake an error for a result.
 */
import sharp from "sharp";

const file = process.argv[2];
if (!file) {
  console.error("usage: check-watermark.mjs <image>");
  process.exit(2);
}

try {
  const { width, height } = await sharp(file).metadata();
  if (!width || !height) throw new Error("unreadable image");

  const bandH = Math.round(height * 0.12);

  const bandBuf = await sharp(file)
    .extract({ left: 0, top: height - bandH, width, height: bandH })
    .toBuffer();
  const midBuf = await sharp(file)
    .extract({ left: 0, top: Math.round(height * 0.3), width, height: bandH })
    .toBuffer();

  const band = (await sharp(bandBuf).stats()).channels[0];
  const middle = (await sharp(midBuf).stats()).channels[0];

  const darker = band.mean < middle.mean - 20;
  const hasText = band.stdev > middle.stdev + 10;

  console.log(darker && hasText ? "burned" : "missing");
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
