/**
 * Authentication service (PRD §5.4, §7.1).
 *
 * Better Auth handles credentials, sessions and throttling. This service owns
 * what the library does not: our landing rules, the shop-picker decision, and
 * the shape of the bootstrap payload.
 *
 * Route handlers under app/api/auth/* authenticate, validate with Zod, and
 * call in here — nothing more.
 */
import { z } from "zod";
import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { auth } from "@/server/auth/auth";
import { prisma } from "@/lib/prisma";
import { AppError, unauthenticated } from "@/server/errors";
import { checkPasswordPolicy } from "@/server/auth/password";
import { signOutCurrent } from "@/server/auth/session";
import { selectableShops, type Actor } from "@/server/auth/context";

// ─────────────────────────────── Schemas ───────────────────────────────

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Enter your username.").max(64),
  password: z.string().min(1, "Enter your password.").max(200),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().min(1, "Enter a new password.").max(200),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// ─────────────────────────────── Login ───────────────────────────────

export interface LoginResult {
  mustChangePassword: boolean;
  /** True when the day-start shop picker must be shown (§4.7). */
  needsWorkSession: boolean;
  landingPath: string;
}

/**
 * Where a role lands after login (§8.0).
 * OWNER → /dashboard. MANAGER and STAFF → /sale.
 */
export function landingPathFor(role: string): string {
  return role === "OWNER" ? "/dashboard" : "/sale";
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const username = input.username.trim().toLowerCase();

  // One message for every failure mode, so the login form cannot be used to
  // discover which usernames exist.
  const genericFailure = unauthenticated("Username or password is incorrect.");

  try {
    // Better Auth sets the session cookie itself via the nextCookies plugin.
    await auth.api.signInUsername({
      body: { username, password: input.password },
      headers: await headers(),
    });
  } catch (e) {
    if (e instanceof APIError) {
      const status = String(e.status);

      // The library's built-in limiter enforces 5 attempts per 15 minutes.
      if (status === "429" || status === "TOO_MANY_REQUESTS") {
        throw new AppError(
          "RATE_LIMITED",
          "Too many failed attempts. Try again in 15 minutes."
        );
      }

      // A deactivated account reads the same as a wrong password from the
      // login screen — it should not be confirmable.
      throw genericFailure;
    }
    throw e;
  }

  const user = await prisma.user.findUnique({
    where: { username },
    select: {
      id: true,
      role: true,
      mustChangePassword: true,
      _count: { select: { userShops: true } },
    },
  });

  if (!user) throw genericFailure;

  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  // A user with exactly one assigned shop never sees the picker (§4.7);
  // resolveWorkSession auto-selects it on the next request.
  const needsWorkSession =
    user.role === "OWNER" ? true : user._count.userShops !== 1;

  return {
    mustChangePassword: user.mustChangePassword,
    needsWorkSession,
    landingPath: landingPathFor(user.role),
  };
}

export async function logout(): Promise<void> {
  await signOutCurrent();
}

// ─────────────────────────── Change password ───────────────────────────

/**
 * Change the caller's own password (§7.1).
 *
 * `currentPassword` is required UNLESS the account is flagged
 * mustChangePassword — that flag exists precisely because the user was handed
 * a temporary password by the owner and may not have one worth re-typing.
 */
export async function changePassword(
  actor: Actor,
  input: ChangePasswordInput
): Promise<void> {
  const policy = checkPasswordPolicy(input.newPassword);
  if (!policy.ok) {
    throw new AppError("VALIDATION_FAILED", policy.message, {
      fields: { newPassword: policy.message },
    });
  }

  const reqHeaders = await headers();

  if (actor.mustChangePassword) {
    /**
     * The user cannot be asked for a password they were merely handed, so the
     * usual changePassword flow (which demands the current one) does not fit.
     *
     * We go through Better Auth's internal adapter rather than its admin
     * endpoint: `setUserPassword` is admin-plugin-gated and would reject a
     * user acting on their own account. Authorisation has already happened —
     * requireActor proved this session owns this account, and the
     * mustChangePassword flag is what put them on this screen.
     *
     * The hash is still produced by our configured argon2id hook, because
     * ctx.password.hash is the same function pair from auth.ts.
     */
    const ctx = await auth.$context;
    const hashed = await ctx.password.hash(input.newPassword);
    await ctx.internalAdapter.updatePassword(actor.userId, hashed);

    // A temporary password may have been seen by someone else; evict every
    // other session now that it has been replaced.
    await prisma.session.deleteMany({
      where: { userId: actor.userId, id: { not: actor.sessionId } },
    });
  } else {
    if (!input.currentPassword) {
      const msg = "Enter your current password.";
      throw new AppError("VALIDATION_FAILED", msg, {
        fields: { currentPassword: msg },
      });
    }

    try {
      await auth.api.changePassword({
        body: {
          currentPassword: input.currentPassword,
          newPassword: input.newPassword,
          // Evict every other session: if the old password leaked, changing
          // it must actually remove whoever used it.
          revokeOtherSessions: true,
        },
        headers: reqHeaders,
      });
    } catch (e) {
      if (e instanceof APIError) {
        const msg = "That is not your current password.";
        throw new AppError("VALIDATION_FAILED", msg, {
          fields: { currentPassword: msg },
        });
      }
      throw e;
    }
  }

  await prisma.user.update({
    where: { id: actor.userId },
    data: { mustChangePassword: false },
  });
}

// ─────────────────────────────── /me ───────────────────────────────

/**
 * Bootstrap payload for the app shell (§7.1).
 *
 * Contains no cost fields and never will — this is fetched by every role.
 */
export async function me(actor: Actor) {
  const shops = await selectableShops(actor);

  return {
    user: {
      id: actor.userId,
      username: actor.username,
      displayName: actor.displayName,
      role: actor.role,
      canEnterCost: actor.canEnterCost,
      mustChangePassword: actor.mustChangePassword,
      defaultShopId: actor.defaultShopId,
    },
    shops: shops.map((s) => ({ id: s.id, code: s.code, name: s.name })),
    workSession: actor.workSession
      ? {
          shopId: actor.workSession.shopId,
          shopName: actor.workSession.shop.name,
          businessDate: actor.workSession.businessDate.toISOString().slice(0, 10),
          changedCount: actor.workSession.changedCount,
        }
      : null,
    businessDate: actor.businessDate.toISOString().slice(0, 10),
    landingPath: landingPathFor(actor.role),
  };
}
