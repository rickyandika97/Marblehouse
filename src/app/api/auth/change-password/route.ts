import { handleRoute, parseJson } from "@/server/http";
import { changePassword, changePasswordSchema } from "@/server/services/auth";
// requireActor, not requireSettledActor: a user flagged mustChangePassword is
// blocked everywhere EXCEPT here — this is the endpoint that clears the flag.
import { requireActor } from "@/server/auth/guards";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireActor();
    const input = await parseJson(req, changePasswordSchema);
    await changePassword(actor, input);
    return { ok: true };
  });
}
