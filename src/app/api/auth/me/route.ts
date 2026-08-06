import { handleRoute } from "@/server/http";
import { me } from "@/server/services/auth";
import { requireActor } from "@/server/auth/guards";

export async function GET() {
  return handleRoute(async () => me(await requireActor()));
}
