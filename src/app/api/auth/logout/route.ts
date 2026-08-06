import { handleRoute } from "@/server/http";
import { logout } from "@/server/services/auth";

export async function POST() {
  return handleRoute(async () => {
    await logout();
    return { ok: true };
  });
}
