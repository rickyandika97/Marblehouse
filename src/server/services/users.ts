/**
 * User administration (PRD §7.9, §3.4 Admin rows).
 *
 * Creating users, setting roles, shop access, default shop, the Purchasing
 * permission, and password resets. OWNER-only in Phase 1 — the one delegated
 * capability a manager has (§3.4: reset password / set default shop for their
 * own staff) arrives with the manager settings screen; every route here is
 * owner-gated until then, which is the safe direction to be wrong in.
 *
 * Every mutation is audit-logged (§4.16).
 */
import { z } from "zod";
import { Prisma, type User } from "@prisma/client";
import { APIError } from "better-auth/api";
import { auth } from "@/server/auth/auth";
import { prisma } from "@/lib/prisma";
import { AppError, forbidden, notFound } from "@/server/errors";
import { writeAudit } from "@/server/audit";
import { checkPasswordPolicy } from "@/server/auth/password";
import type { Actor } from "@/server/auth/context";

/**
 * Synthetic login address (§5.4, decided 4 Aug 2026).
 *
 * THIS ADDRESS IS FAKE AND MUST STAY FAKE. Better Auth structurally requires a
 * unique, non-null email, but this business collects none — staff have no work
 * email addresses, and the PRD says so plainly: "Email is not collected at
 * all."
 *
 * `.invalid` is reserved by RFC 2606 and can never resolve. That is the point:
 * if an email-sending path is ever switched on by mistake, it fails hard
 * instead of delivering mail to a real stranger who happens to own the domain.
 *
 * DO NOT "fix" this by wiring up real email or by switching to `.local`
 * (which is mDNS and does resolve on a LAN). A forgotten password is reset by
 * the owner from Settings → Users; that is the designed path.
 *
 * The username is immutable after creation, so this value never needs syncing.
 */
function syntheticEmail(username: string): string {
  return `${username.toLowerCase()}@marblehouse.invalid`;
}

// ─────────────────────────────── Schemas ───────────────────────────────

const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters.")
  .max(32, "Username must be 32 characters or fewer.")
  .regex(
    /^[a-z0-9._-]+$/,
    "Use letters, numbers, dots, dashes or underscores only."
  );

const role = z.enum(["OWNER", "MANAGER", "STAFF"]);

export const createUserSchema = z
  .object({
    username,
    displayName: z.string().trim().min(1, "Enter a name.").max(80),
    password: z.string().min(1, "Enter a temporary password.").max(200),
    role,
    phone: z.string().trim().max(32).optional(),
    shopIds: z.array(z.string().min(1)).default([]),
    defaultShopId: z.string().min(1).nullable().optional(),
    canEnterCost: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    // A manager or staff member with no shop can do nothing at all — they
    // would log in and hit an empty picker. Catch it here, not in support.
    if (v.role !== "OWNER" && v.shopIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["shopIds"],
        message: "Assign at least one shop.",
      });
    }

    if (v.defaultShopId && !v.shopIds.includes(v.defaultShopId) && v.role !== "OWNER") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["defaultShopId"],
        message: "The default shop must be one of the assigned shops.",
      });
    }

    // canEnterCost is meaningful only on a MANAGER (§7.5); it is ignored on
    // STAFF and redundant on OWNER. Reject rather than silently drop it.
    if (v.canEnterCost && v.role !== "MANAGER") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["canEnterCost"],
        message: "The Purchasing permission applies to managers only.",
      });
    }
  });

/**
 * Username is deliberately absent: it is IMMUTABLE after creation (§5.4
 * decision, 4 Aug 2026). It seeds the synthetic login address, and keeping the
 * two in sync would be a class of bug for no benefit. `displayName` is the
 * mutable, human-facing name. To change a username, deactivate the account and
 * create a new one.
 */
export const updateUserSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  role: role.optional(),
  isActive: z.boolean().optional(),
  /** Why the account was deactivated — recorded and audit-logged (§4.16). */
  deactivationReason: z.string().trim().max(500).optional(),
  canEnterCost: z.boolean().optional(),
  shopIds: z.array(z.string().min(1)).optional(),
  defaultShopId: z.string().min(1).nullable().optional(),
});

export const resetPasswordSchema = z.object({
  newPassword: z.string().min(1, "Enter a temporary password.").max(200),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

// ─────────────────────────────── DTO ───────────────────────────────

/**
 * User DTO. Carries no password hash and no cost figures — only the
 * `canEnterCost` FLAG, which is a permission, not a cost value.
 */
export function toUserDTO(
  u: User & { userShops?: { shopId: string }[] }
) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    phone: u.phone,
    /**
     * Derived, never stored (decision, 4 Aug 2026). `banned` is the single
     * source of truth for access; the UI speaks in terms of "Deactivated"
     * because most cases are staff leaving, not misconduct.
     */
    isActive: !u.banned,
    deactivationReason: u.banReason,
    canEnterCost: u.canEnterCost,
    mustChangePassword: u.mustChangePassword,
    defaultShopId: u.defaultShopId,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    shopIds: u.userShops?.map((s) => s.shopId) ?? [],
    // The synthetic email is deliberately NOT exposed — it is an internal key,
    // not contact information, and showing it invites someone to "correct" it.
  };
}

// ─────────────────────────────── Queries ───────────────────────────────

export async function listUsers(actor: Actor) {
  if (actor.role !== "OWNER") throw forbidden("Only the owner can manage users.");

  const users = await prisma.user.findMany({
    include: { userShops: { select: { shopId: true } } },
    // Active users first: `banned` ascending puts false (and null) above true.
    orderBy: [{ banned: "asc" }, { role: "asc" }, { displayName: "asc" }],
  });

  return users.map(toUserDTO);
}

// ─────────────────────────────── Mutations ───────────────────────────────

/** Validate that every referenced shop exists and is active. */
async function assertShopsExist(shopIds: string[]): Promise<void> {
  if (shopIds.length === 0) return;

  const found = await prisma.shop.count({
    where: { id: { in: shopIds }, isActive: true },
  });

  if (found !== shopIds.length) {
    throw new AppError("VALIDATION_FAILED", "One of the shops is not available.", {
      fields: { shopIds: "One of the shops is not available." },
    });
  }
}

export async function createUser(
  actor: Actor,
  input: CreateUserInput,
  meta: { ipAddress?: string | null } = {}
) {
  if (actor.role !== "OWNER") throw forbidden("Only the owner can create users.");

  const policy = checkPasswordPolicy(input.password);
  if (!policy.ok) {
    throw new AppError("VALIDATION_FAILED", policy.message, {
      fields: { password: policy.message },
    });
  }

  await assertShopsExist(input.shopIds);

  // Reject a duplicate username before touching the auth layer, so the error
  // we show is the accurate one rather than whatever the library raises last.
  const taken = await prisma.user.findUnique({
    where: { username: input.username },
    select: { id: true },
  });
  if (taken) {
    throw new AppError("CONFLICT", "That username is already taken.", {
      fields: { username: "That username is already taken." },
    });
  }

  /**
   * Create through Better Auth's internal adapter so the credential account
   * and its argon2id hash are created the way the library expects — a
   * directly-inserted user row would have no password and could never log in.
   *
   * We use the internal adapter rather than `auth.api.createUser`, which is
   * admin-plugin-gated and would 403 here: our OWNER role is deliberately not
   * registered in the plugin's access-control map (see auth.ts). Authorisation
   * has already happened — requireOwner ran before this service was called.
   */
  const ctx = await auth.$context;

  let createdId: string;
  try {
    const created = await ctx.internalAdapter.createUser({
      email: syntheticEmail(input.username),
      name: input.displayName,
      emailVerified: false,
      username: input.username,
      displayUsername: input.username,
      displayName: input.displayName,
      role: input.role,
      phone: input.phone || null,
      canEnterCost: input.role === "MANAGER" ? input.canEnterCost : false,
      // Always true on creation: the owner knows the temporary password, so
      // the account is not private until the user replaces it (§5.4).
      mustChangePassword: true,
      defaultShopId: input.defaultShopId ?? input.shopIds[0] ?? null,
    });

    createdId = created.id;

    await ctx.internalAdapter.linkAccount({
      userId: createdId,
      providerId: "credential",
      accountId: createdId,
      password: await ctx.password.hash(input.password),
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      throw new AppError("CONFLICT", "That username is already taken.", {
        fields: { username: "That username is already taken." },
      });
    }
    if (e instanceof APIError) {
      throw new AppError(
        "INTERNAL",
        "Could not create the account. Try again, and tell the owner if it keeps happening."
      );
    }
    throw e;
  }

  // Shop assignments are ours, not the auth library's.
  const user = await prisma.$transaction(async (tx) => {
    await tx.userShop.createMany({
      data: input.shopIds.map((shopId) => ({ userId: createdId, shopId })),
      skipDuplicates: true,
    });

    const withShops = await tx.user.findUniqueOrThrow({
      where: { id: createdId },
      include: { userShops: { select: { shopId: true } } },
    });

    await writeAudit(
      actor,
      {
        entity: "User",
        entityId: createdId,
        action: "CREATE",
        after: {
          username: withShops.username,
          displayName: withShops.displayName,
          role: withShops.role,
          canEnterCost: withShops.canEnterCost,
          shopIds: input.shopIds,
          defaultShopId: withShops.defaultShopId,
        },
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return withShops;
  });

  return toUserDTO(user);
}

export async function updateUser(
  actor: Actor,
  userId: string,
  input: UpdateUserInput,
  meta: { ipAddress?: string | null } = {}
) {
  if (actor.role !== "OWNER") throw forbidden("Only the owner can edit users.");

  const existing = await prisma.user.findUnique({
    where: { id: userId },
    include: { userShops: { select: { shopId: true } } },
  });
  if (!existing) throw notFound("That user no longer exists.");

  // An owner must not be able to lock themselves out of their own system.
  if (existing.id === actor.userId) {
    if (input.isActive === false) {
      throw new AppError("VALIDATION_FAILED", "You cannot deactivate your own account.");
    }
    if (input.role && input.role !== existing.role) {
      throw new AppError("VALIDATION_FAILED", "You cannot change your own role.");
    }
  }

  // Never leave the system with no way in.
  if (
    existing.role === "OWNER" &&
    ((input.role && input.role !== "OWNER") || input.isActive === false)
  ) {
    const otherOwners = await prisma.user.count({
      where: { role: "OWNER", banned: { not: true }, id: { not: existing.id } },
    });
    if (otherOwners === 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "This is the last active owner. Create another owner before changing this account."
      );
    }
  }

  const nextRole = input.role ?? existing.role;

  if (input.shopIds) await assertShopsExist(input.shopIds);

  const nextShopIds = input.shopIds ?? existing.userShops.map((s) => s.shopId);

  if (nextRole !== "OWNER" && nextShopIds.length === 0) {
    throw new AppError("VALIDATION_FAILED", "Assign at least one shop.", {
      fields: { shopIds: "Assign at least one shop." },
    });
  }

  const nextDefault =
    input.defaultShopId === undefined ? existing.defaultShopId : input.defaultShopId;

  if (nextDefault && nextRole !== "OWNER" && !nextShopIds.includes(nextDefault)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The default shop must be one of the assigned shops.",
      { fields: { defaultShopId: "Must be one of the assigned shops." } }
    );
  }

  // Purchasing is a manager-only permission (§7.5) — drop it on any other role
  // rather than leaving a stale true on a demoted account.
  const nextCanEnterCost =
    nextRole === "MANAGER" ? (input.canEnterCost ?? existing.canEnterCost) : false;

  const updated = await prisma.$transaction(async (tx) => {
    if (input.shopIds) {
      await tx.userShop.deleteMany({ where: { userId } });
      await tx.userShop.createMany({
        data: input.shopIds.map((shopId) => ({ userId, shopId })),
        skipDuplicates: true,
      });
    }

    const user = await tx.user.update({
      where: { id: userId },
      data: {
        displayName: input.displayName ?? undefined,
        // `name` is Better Auth's core display field; keep it mirrored so the
        // library and our UI never show different names for one person.
        name: input.displayName ?? undefined,
        phone: input.phone === undefined ? undefined : input.phone,
        role: input.role ?? undefined,
        // Deactivation is stored as `banned` — the single source of truth.
        // Username is immutable and is deliberately not settable here.
        banned: input.isActive === undefined ? undefined : !input.isActive,
        banReason:
          input.isActive === undefined
            ? undefined
            : input.isActive
              ? null
              : (input.deactivationReason?.trim() || "Deactivated by owner"),
        canEnterCost: nextCanEnterCost,
        defaultShopId: nextDefault,
      },
      include: { userShops: { select: { shopId: true } } },
    });

    await writeAudit(
      actor,
      {
        entity: "User",
        // Name the action for what it is: staff leaving is the common case.
        action:
          input.isActive === false
            ? "DEACTIVATE"
            : input.isActive === true
              ? "REACTIVATE"
              : "UPDATE",
        entityId: userId,
        before: {
          displayName: existing.displayName,
          role: existing.role,
          isActive: !existing.banned,
          canEnterCost: existing.canEnterCost,
          shopIds: existing.userShops.map((s) => s.shopId),
          defaultShopId: existing.defaultShopId,
        },
        after: {
          displayName: user.displayName,
          role: user.role,
          isActive: !user.banned,
          canEnterCost: user.canEnterCost,
          shopIds: user.userShops.map((s) => s.shopId),
          defaultShopId: user.defaultShopId,
        },
        reason: input.deactivationReason?.trim() || null,
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return user;
  });

  // Revoking access must take effect now, not in up to 12 hours (R-9).
  // Historical rows — sales, ledger entries, attendance — are untouched and
  // still attribute to this user. Deactivation is never a delete.
  if (input.isActive === false || (input.role && input.role !== existing.role)) {
    await prisma.session.deleteMany({ where: { userId } });
  }

  return toUserDTO(updated);
}

/**
 * Reset another user's password (§7.9).
 *
 * Sets a temporary password and forces a change on next login. Every existing
 * session for that user is destroyed — otherwise a reset would not evict
 * whoever prompted the reset in the first place.
 */
export async function resetUserPassword(
  actor: Actor,
  userId: string,
  newPassword: string,
  meta: { ipAddress?: string | null } = {}
): Promise<void> {
  if (actor.role !== "OWNER") {
    throw forbidden("Only the owner can reset passwords.");
  }

  const target = await prisma.user.findUnique({ where: { id: userId } });
  if (!target) throw notFound("That user no longer exists.");

  const policy = checkPasswordPolicy(newPassword);
  if (!policy.ok) {
    throw new AppError("VALIDATION_FAILED", policy.message, {
      fields: { newPassword: policy.message },
    });
  }

  // Internal adapter, not the admin endpoint — same reason as createUser:
  // the plugin gate would 403, and requireOwner has already authorised this.
  const ctx = await auth.$context;
  await ctx.internalAdapter.updatePassword(
    userId,
    await ctx.password.hash(newPassword)
  );

  await prisma.user.update({
    where: { id: userId },
    data: { mustChangePassword: true },
  });

  await writeAudit(actor, {
    entity: "User",
    entityId: userId,
    action: "RESET_PASSWORD",
    // Never log the password itself, temporary or not.
    after: { username: target.username, mustChangePassword: true },
    ipAddress: meta.ipAddress ?? null,
  });

  // A reset must evict whoever prompted it.
  await prisma.session.deleteMany({ where: { userId } });
}
