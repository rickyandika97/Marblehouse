import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { requireOwner } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import { resolveArchiveForDownload } from "@/server/services/backup";

/**
 * One-tap export (§13.4). STREAMED, not buffered — an archive holds the
 * whole database plus every attendance photo and receipt, easily large
 * enough that reading it fully into memory first would be wasteful on the
 * owner's own machine.
 *
 * No `?file=` names the newest archive. The archive contains password
 * hashes, customer names and phone numbers (§13.5), so this is the one place
 * a filename from a URL could turn into "read any file on the server" —
 * `resolveArchiveForDownload` matches it against the actual directory
 * listing rather than sanitising, which is what makes traversal impossible
 * rather than merely blocked.
 */
export async function GET(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const fileName = new URL(req.url).searchParams.get("file");
    const archive = await resolveArchiveForDownload(actor, fileName);

    const stream = Readable.toWeb(
      createReadStream(archive.filePath)
    ) as ReadableStream;

    return new Response(stream, {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${archive.fileName}"`,
        "Content-Length": String(archive.sizeBytes),
        // Never let a shared tablet's browser or an intermediary hold a copy.
        "Cache-Control": "no-store, private",
      },
    });
  });
}
