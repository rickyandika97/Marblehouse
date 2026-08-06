import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/server/auth/auth";

/**
 * Better Auth's own endpoints (§5.4).
 *
 * Note our hand-written routes at /api/auth/login, /logout, /me and
 * /change-password sit ALONGSIDE these: Next.js prefers the more specific
 * segment over this catch-all. Those routes are the ones the UI calls, because
 * they apply our landing rules and our error envelope (§7). This catch-all
 * exists because the library needs its own paths reachable.
 */
export const { GET, POST } = toNextJsHandler(auth);
