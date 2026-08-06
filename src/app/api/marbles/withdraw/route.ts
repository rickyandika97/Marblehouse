import { requireWorkSession } from "@/server/auth/guards";
import { handleRoute, parseJson } from "@/server/http";
import { parseIdempotencyKey, runIdempotent } from "@/server/idempotency";
import { marbleChangeSchema, withdrawMarbles } from "@/server/services/marbles";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireWorkSession();
    const key = parseIdempotencyKey(req);
    const input = await parseJson(req, marbleChangeSchema);
    return runIdempotent(actor, key, "POST /api/marbles/withdraw", (tx) =>
      withdrawMarbles(actor, input, tx)
    );
  });
}

