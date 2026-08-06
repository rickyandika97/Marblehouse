import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Edge-level gate (PRD §5.4).
 *
 * IMPORTANT: this middleware only checks whether a session COOKIE is present.
 * It is a redirect convenience, not a permission — it cannot read the database
 * or know a role, and a cookie can be forged.
 *
 * The real enforcement is server-side in every page and route handler, via
 * requireActor / requireRole / requireShopAccess. That is what makes a STAFF
 * account typing an admin URL get a 403 instead of a render (§3.4).
 *
 * Note this runs on the Node.js runtime, not the edge runtime — nothing in
 * this project may depend on Vercel-only features (§5.2).
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Cookie presence only — this does NOT validate the session. The prefix must
  // match `advanced.cookiePrefix` in auth.ts, or every request looks signed out.
  const hasCookie = Boolean(
    getSessionCookie(req, { cookiePrefix: "marblehouse" })
  );

  // Already signed in and heading for the login page → send them home. The
  // destination page resolves the real landing route for their role.
  if (hasCookie && pathname === "/login") {
    return NextResponse.redirect(new URL("/", req.url));
  }

  if (!hasCookie && !isPublicPath(pathname)) {
    /**
     * An API caller must never receive an HTML login page. Redirecting a fetch
     * gives the client unparseable markup where it expected our error envelope
     * (§7), which surfaces to staff as an incomprehensible failure instead of
     * "please log in". Return the envelope directly.
     */
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        {
          error: {
            code: "UNAUTHENTICATED",
            message: "Please log in to continue.",
            details: {},
          },
        },
        { status: 401 }
      );
    }

    const url = new URL("/login", req.url);
    // Preserve where they were going, so a deep link survives the login.
    if (pathname !== "/") url.searchParams.set("next", pathname + search);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    // Every Better Auth endpoint, plus our own login route. Sign-in must be
    // reachable without a session, and redirecting an API call to an HTML
    // login page would give the client an unparseable response.
    pathname.startsWith("/api/auth/") ||
    pathname === "/api/health"
  );
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static assets. Note that API routes
     * ARE matched: an unauthenticated API call should fail fast rather than
     * reach a handler.
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:png|jpg|jpeg|svg|webp|ico)$).*)",
  ],
};
