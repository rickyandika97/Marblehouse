import { handleRoute, parseJson } from "@/server/http";
import { AppError } from "@/server/errors";
import {
  readMembershipDownload,
  readMembershipDownloadSchema,
} from "@/server/services/membership-download";
export async function POST(req: Request) {
  const response = await handleRoute(async () => {
    const { token } = await parseJson(req, readMembershipDownloadSchema);
    try {
      return await readMembershipDownload(token);
    } catch (error) {
      if (error instanceof AppError) throw error;
      // Never log unexpected database errors with the card credential they may contain.
      throw new AppError(
        "INTERNAL",
        "Kartu belum bisa dimuat. Coba lagi atau hubungi staf.",
      );
    }
  });
  response.headers.set("Cache-Control", "no-store, private");
  response.headers.set("Referrer-Policy", "no-referrer");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}
