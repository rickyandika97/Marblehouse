import { handleRoute, parseJson } from "@/server/http";
import { login, loginSchema } from "@/server/services/auth";

export async function POST(req: Request) {
  return handleRoute(async () => {
    const input = await parseJson(req, loginSchema);
    // Better Auth reads the request headers itself and sets the session cookie
    // via the nextCookies plugin, so no IP/UA plumbing is needed here.
    return login(input);
  });
}
