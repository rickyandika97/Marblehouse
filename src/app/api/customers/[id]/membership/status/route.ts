import { requireSettledActor } from "@/server/auth/guards";
import { handleRoute } from "@/server/http";
import { membershipStatus } from "@/server/services/membership";
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const response = await handleRoute(async () =>
    membershipStatus(await requireSettledActor(), (await params).id),
  );
  response.headers.set("Cache-Control", "no-store, private");
  return response;
}
