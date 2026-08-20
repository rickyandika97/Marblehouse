import { readFile } from "node:fs/promises";
import { handleRoute, clientIp } from "@/server/http";
import {
  requireSettledActor,
  requireManagerOrOwner,
} from "@/server/auth/guards";
import {
  clearPrizeImage,
  getPrizeImagePath,
  setPrizeImage,
} from "@/server/services/prizes";
import {
  resolvePrizeImagePath,
  storePrizeImage,
} from "@/server/services/prize-image";
import { AppError, notFound } from "@/server/errors";

/**
 * The prize catalog image (§4.8, §8.6).
 *
 * Served ONLY through this authenticated route, never as a static path. A
 * prize photo is not sensitive the way a receipt or an attendance photo is —
 * it is a picture of a teddy bear — but keeping one rule for all three means
 * there is no "is this image the public kind?" judgement to get wrong later,
 * and no permanently guessable URL into the data directory. Owner decision,
 * 19 Aug 2026.
 *
 * Any signed-in role may READ: staff need images to redeem (§8.6). Writing is
 * MANAGER or OWNER, matching every other catalog mutation.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;

    const relativePath = await getPrizeImagePath(actor, id);

    let bytes: Buffer;
    try {
      bytes = await readFile(resolvePrizeImagePath(relativePath));
    } catch {
      throw notFound("That image is no longer on disk.");
    }

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        // Longer than a receipt's 300s: a prize image is catalog data that
        // rarely changes, and §8.6's grid may render dozens at once on a
        // tablet over shop wifi. `private` still keeps it out of shared
        // caches. Replacing an image changes nothing about this URL, so the
        // upload response triggers a refresh rather than relying on expiry.
        "Cache-Control": "private, max-age=3600",
        "Content-Length": String(bytes.byteLength),
      },
    });
  });
}

/**
 * Upload or replace a prize's image.
 *
 * Separate from `PATCH /api/prizes/:id` on purpose, exactly as the receipt
 * route is separate from expense creation: the catalog row is the record that
 * must land, and a flaky upload on shop wifi must not take the rest of an edit
 * down with it. The service deletes the superseded file.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;

    const form = await req.formData().catch(() => null);
    const file = form?.get("image");
    if (!(file instanceof File)) {
      throw new AppError("VALIDATION_FAILED", "Attach an image.");
    }

    const { relativePath } = await storePrizeImage(await file.arrayBuffer());
    return setPrizeImage(actor, id, relativePath, { ipAddress: clientIp(req) });
  });
}

/** Remove a prize's image. Idempotent — see `clearPrizeImage`. */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireManagerOrOwner();
    const { id } = await params;
    return clearPrizeImage(actor, id, { ipAddress: clientIp(req) });
  });
}
