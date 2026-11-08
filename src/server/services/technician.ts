import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import type { GenericEndpointContext } from "better-auth";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertTechnician, isTechnicianAccount, businessUsersWhere } from "@/server/auth/technician";
import { AppError, forbidden, unauthenticated } from "@/server/errors";

const DURATION = 3600;
async function authErrors<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof AppError) throw new APIError(error.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", { message: error.message });
    throw error;
  }
}

async function parentSession(ctx: GenericEndpointContext) {
  const cookie = ctx.context.createAuthCookie("technician_session");
  const backup = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!backup) throw unauthenticated("Sign in to your technician account again.");
  const [token, borrowedId] = backup.split(":");
  const parent = token ? await ctx.context.internalAdapter.findSession(token) : null;
  if (!parent || parent.session.expiresAt <= new Date()) throw unauthenticated("Your technician session expired.");
  const user = await prisma.user.findUnique({ where: { id: parent.user.id } });
  assertTechnician(user);
  return { parent, borrowedId, cookie };
}

export async function listTechnicianUsers(technicianId: string) {
  assertTechnician(await prisma.user.findUnique({ where: { id: technicianId } }));
  return prisma.user.findMany({
    where: businessUsersWhere(),
    select: {
      id: true, username: true, displayName: true, isOwner: true, banned: true,
      userShops: { select: { role: true, shop: { select: { name: true } } } },
    },
    orderBy: [{ isOwner: "desc" }, { displayName: "asc" }],
  });
}

/** No audit rows or last-login tracking are written by support operations. */
export const technicianPlugin = () => ({
  id: "technician",
  endpoints: {
    technicianSessionStatus: createAuthEndpoint("/technician/session-status", {
      method: "GET", requireHeaders: true,
    }, async (ctx) => {
      const current = await getSessionFromCtx(ctx);
      if (!current) return { valid: false };
      if (!current.session.impersonatedBy) return { valid: true };
      try {
        const { parent, borrowedId } = await parentSession(ctx);
        return { valid: borrowedId === current.session.id && parent.user.id === current.session.impersonatedBy
          && Date.now() - new Date(current.session.createdAt).getTime() < DURATION * 1000 };
      } catch { return { valid: false }; }
    }),
    startTechnicianImpersonation: createAuthEndpoint("/technician/start", {
      method: "POST", requireHeaders: true,
      body: z.object({ userId: z.string().min(1).max(128) }),
    }, async (ctx) => authErrors(async () => {
      const current = await getSessionFromCtx(ctx);
      if (!current) throw unauthenticated();
      assertTechnician(await prisma.user.findUnique({ where: { id: current.user.id } }));
      if (current.session.impersonatedBy) throw forbidden("Return to the technician screen first.");
      const cookie = ctx.context.createAuthCookie("technician_session");
      if (await ctx.getSignedCookie(cookie.name, ctx.context.secret)) throw forbidden("Return to the technician screen first.");
      const target = await prisma.user.findUnique({ where: { id: ctx.body.userId } });
      if (!target || target.banned || isTechnicianAccount(target)) throw forbidden("Choose an active business user.");
      const user = await ctx.context.internalAdapter.findUserById(target.id);
      if (!user) throw unauthenticated();
      const session = await ctx.context.internalAdapter.createSession(target.id, true, {
        impersonatedBy: current.user.id,
        expiresAt: new Date(Date.now() + DURATION * 1000),
      }, true);
      if (!session) throw new APIError("INTERNAL_SERVER_ERROR", { message: "Could not start session." });
      await ctx.setSignedCookie(cookie.name, `${current.session.token}:${session.id}`,
        ctx.context.secret, { ...cookie.attributes, maxAge: undefined });
      deleteSessionCookie(ctx);
      await setSessionCookie(ctx, { session, user }, true);
      return ctx.json({ landingPath: target.mustChangePassword ? "/change-password" : target.isOwner ? "/dashboard" : "/sale" });
    })),
    stopTechnicianImpersonation: createAuthEndpoint("/technician/stop", {
      method: "POST", requireHeaders: true,
    }, async (ctx) => authErrors(async () => {
      const { parent, borrowedId, cookie } = await parentSession(ctx);
      await prisma.session.deleteMany({ where: { id: borrowedId ?? "", impersonatedBy: parent.user.id } });
      deleteSessionCookie(ctx);
      await setSessionCookie(ctx, parent);
      ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
      return ctx.json({ landingPath: "/technician" });
    })),
  },
});
