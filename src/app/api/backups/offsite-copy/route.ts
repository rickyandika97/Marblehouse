import { z } from "zod";
import { requireOwner } from "@/server/auth/guards";
import { clientIp, handleRoute, parseJson } from "@/server/http";
import { recordOffsiteCopy } from "@/server/services/backup";

const offsiteCopySchema = z.object({
  fileName: z.string().min(1).optional(),
});

/**
 * §13.4's off-machine copy log — an honour-system button. Its job is to
 * drive the reminder, not to prove anything; see backup.ts for why the red
 * state it clears is blunt and undismissable.
 *
 * An omitted `fileName` resolves to the newest archive server-side, which is
 * what the primary "I copied this off-machine" button on the latest backup
 * sends.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireOwner();
    const input = await parseJson(req, offsiteCopySchema);
    return recordOffsiteCopy(actor, input.fileName ?? null, {
      ipAddress: clientIp(req),
    });
  });
}
