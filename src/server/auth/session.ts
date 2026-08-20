/**
 * Session access (PRD §5.4).
 *
 * Better Auth owns session creation, rotation, token comparison and cookie
 * flags. This module is a thin, typed accessor over it — it exists so the rest
 * of the codebase never imports the auth library directly and so the
 * additionalFields typing is asserted in exactly one place.
 */
import { headers } from "next/headers";
import { auth } from "./auth";

/**
 * Better Auth's inferred user type does not carry `user.additionalFields`
 * reliably — a known rough edge called out in §5.4, which also says: do not
 * work around it by casting to `any`, write the type.
 *
 * So this is the explicit contract for the fields we added in auth.ts. It is
 * asserted once, here, against the session the library returns.
 */
export interface AuthUserFields {
  id: string;
  name: string;
  email: string;
  username: string | null;
  displayUsername: string | null;
  banned: boolean | null;
  displayName: string;
  isOwner: boolean | null;
  defaultShopId: string | null;
  mustChangePassword: boolean | null;
}

export interface AuthSessionFields {
  id: string;
  userId: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  user: AuthUserFields;
  session: AuthSessionFields;
}

/**
 * Read the current session from the request cookies.
 *
 * Returns null when unauthenticated. Never throws — callers decide whether
 * absence is a redirect or a 401.
 */
export async function getAuthSession(): Promise<ResolvedSession | null> {
  const result = await auth.api
    .getSession({ headers: await headers() })
    .catch(() => null);

  if (!result?.user || !result.session) return null;

  // The library returns its own inferred shape; narrow it to our declared
  // contract rather than casting through `any`.
  const user = result.user as unknown as AuthUserFields;
  const session = result.session as unknown as AuthSessionFields;

  return { user, session };
}

/** Sign out the current session and clear the cookie. */
export async function signOutCurrent(): Promise<void> {
  await auth.api.signOut({ headers: await headers() }).catch(() => undefined);
}
