import { readFile } from "node:fs/promises";
import { handleRoute } from "@/server/http";
import { requireActor } from "@/server/auth/guards";
import { getAttendancePhotoPath } from "@/server/services/attendance";
import { resolvePhotoPath } from "@/server/services/attendance-photo";
import { notFound } from "@/server/errors";

/**
 * The watermarked photo (§4.15, §7.7).
 *
 * **This is the ONLY way an attendance photo is served.** `data/` is never
 * exposed statically, because a static path is a permanent public URL for a
 * photograph of a staff member at a known place and time. Every request
 * re-checks role and shop access through the same rule the detail view uses.
 *
 * `Cache-Control: private` keeps it out of shared caches; a shop tablet is
 * often behind a proxy that would otherwise hold it.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const { id } = await params;

    const relativePath = await getAttendancePhotoPath(actor, id);

    let bytes: Buffer;
    try {
      bytes = await readFile(resolvePhotoPath(relativePath));
    } catch {
      // The row still points at a file the purge job or a manual cleanup has
      // already removed. A 404 is the honest answer.
      throw notFound("That photo is no longer on disk.");
    }

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=300",
        "Content-Length": String(bytes.byteLength),
      },
    });
  });
}
