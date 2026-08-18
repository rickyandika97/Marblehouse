/**
 * User administration (PRD §7.9, §5.4; BUILD-LOG D-109).
 *
 * `updateUser` and `resetUserPassword` shipped in Phase 1 and had **no unit
 * tests** — nothing called them from the UI either (D-107), so building the
 * edit screen is the first time they are exercised outside a curl script.
 *
 * What is worth proving rather than assuming, because each one locks the owner
 * out of their own system or silently removes someone's access:
 *
 *  - **You cannot deactivate yourself or change your own role.**
 *  - **The last active owner cannot be demoted or deactivated.**
 *  - **Nobody is left with zero shops.**
 *  - **A demoted manager loses `canEnterCost`** — a stale `true` on a STAFF row
 *    would be a cost-visibility hole (§7.5).
 *  - **Deactivating and resetting a password both destroy live sessions** (R-9).
 *  - **The username is immutable** — it seeds the synthetic login address (D-3).
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { prisma, uniq } from "./helpers";
import {
  listUsers,
  resetUserPassword,
  updateUser,
  updateUserSchema,
} from "../users";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

const TEST_CODE_PREFIX = "ZUSR";
const testCode = () => `${TEST_CODE_PREFIX}${uniq().slice(0, 5)}`.toUpperCase();

const shopIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.account.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  await prisma.shop.deleteMany({
    where: { code: { startsWith: TEST_CODE_PREFIX } },
  });

  userIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeShop() {
  const shop = await prisma.shop.create({
    data: { code: testCode(), name: `User Test ${uniq()}`, timezone: "Asia/Jakarta" },
  });
  shopIds.push(shop.id);
  return shop;
}

/** A user row to act ON, plus the Actor form for acting AS. */
async function makeUser(
  role: Actor["role"],
  opts: { shops?: string[]; canEnterCost?: boolean } = {},
) {
  const id = uniq();
  const user = await prisma.user.create({
    data: {
      email: `usr-${id}@marblehouse.invalid`,
      name: `Usr ${id}`,
      username: `usr-${id}`,
      displayName: `Usr ${id}`,
      role,
      canEnterCost: opts.canEnterCost ?? false,
      defaultShopId: opts.shops?.[0] ?? null,
      // The column defaults to TRUE (§5.4 — a new account must set its own
      // password). Start settled, so a test asserting the RESET turned it on
      // is proving something rather than reading the default back.
      mustChangePassword: false,
    },
  });
  userIds.push(user.id);

  for (const shopId of opts.shops ?? []) {
    await prisma.userShop.create({ data: { userId: user.id, shopId } });
  }

  const actor = {
    sessionId: `sess-${id}`,
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role,
    isActive: true,
    mustChangePassword: false,
    canEnterCost: opts.canEnterCost ?? false,
    defaultShopId: opts.shops?.[0] ?? null,
    assignedShopIds: opts.shops ?? [],
    businessDate: new Date("2026-08-18T00:00:00.000Z"),
    workSession: null,
  } as unknown as Actor;

  return { user, actor };
}

// ─────────────────── guards that prevent a lockout ───────────────────

describe("an owner cannot lock themselves out", () => {
  it("refuses to deactivate your own account", async () => {
    const { user, actor } = await makeUser("OWNER");

    const error = await updateUser(actor, user.id, { isActive: false }).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("your own account");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.banned).not.toBe(true);
  });

  it("refuses to change your own role", async () => {
    const { user, actor } = await makeUser("OWNER");

    const error = await updateUser(actor, user.id, { role: "STAFF" }).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.role).toBe("OWNER");
  });

  it("refuses to deactivate the LAST active owner", async () => {
    /**
     * This test has to reach a state the system exists to prevent: exactly one
     * active owner. Reaching it means disabling the seed owner, and an earlier
     * draft did that WITHOUT restoring — which left `owner` banned in the dev
     * database and broke every later run and every login (the same residue
     * trap as D-102).
     *
     * So: record every active owner up front, restore all of them in a
     * `finally`, and never assume the seed's state on entry.
     */
    const before = await prisma.user.findMany({
      where: { role: "OWNER", banned: { not: true } },
      select: { id: true },
    });

    // Our own two owners: one to act as, one to be the last one standing.
    const { actor } = await makeUser("OWNER");
    const { user: survivor } = await makeUser("OWNER");

    try {
      // Retire every OTHER active owner — the seed's, and our acting one —
      // so `survivor` is genuinely the only one left. The acting owner is
      // still allowed through the role gate: the Actor is built in memory,
      // which is what lets this test reach the guard at all.
      await prisma.user.updateMany({
        where: {
          role: "OWNER",
          banned: { not: true },
          id: { not: survivor.id },
        },
        data: { banned: true },
      });

      // Deactivating, not demoting: an OWNER has no shops, so a demotion trips
      // the "assign at least one shop" rule FIRST — correct, but a different
      // guard than the one under test here.
      const error = await updateUser(actor, survivor.id, {
        isActive: false,
      }).catch((e) => e);

      expect(error).toBeInstanceOf(AppError);
      expect(error.message).toContain("last active owner");

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: survivor.id },
      });
      expect(after.banned).not.toBe(true);
    } finally {
      // Restore every owner that was active when this test began — including
      // the seed's, whatever happened above.
      await prisma.user.updateMany({
        where: { id: { in: before.map((o) => o.id) } },
        data: { banned: false, banReason: null },
      });
    }
  });
});

// ─────────────────────── shops and permissions ───────────────────────

describe("editing shops and permissions", () => {
  it("refuses to leave a MANAGER or STAFF with no shop", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    const error = await updateUser(owner, staff.id, { shopIds: [] }).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("at least one shop");

    await expect(
      prisma.userShop.count({ where: { userId: staff.id } }),
    ).resolves.toBe(1);
  });

  it("replaces the shop list wholesale, as the schema intends", async () => {
    const a = await makeShop();
    const b = await makeShop();
    const c = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [a.id, b.id] });

    // `defaultShopId` currently points at A. Dropping A without moving it
    // trips the "default must be one of the assigned shops" rule — correct,
    // and the reason the edit form always submits both together.
    await updateUser(owner, staff.id, {
      shopIds: [b.id, c.id],
      defaultShopId: b.id,
    });

    const after = await prisma.userShop.findMany({
      where: { userId: staff.id },
      select: { shopId: true },
    });
    // THIS is why the edit form must render every shop the user already holds:
    // anything absent from the submitted array is removed (D-109).
    expect(after.map((r) => r.shopId).sort()).toEqual([b.id, c.id].sort());
  });

  it("strips canEnterCost when a manager is demoted (§7.5)", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: mgr } = await makeUser("MANAGER", {
      shops: [shop.id],
      canEnterCost: true,
    });

    await updateUser(owner, mgr.id, { role: "STAFF" });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: mgr.id } });
    // A stale `true` on a STAFF row would be a cost-visibility hole.
    expect(after.role).toBe("STAFF");
    expect(after.canEnterCost).toBe(false);
  });

  it("refuses a default shop that is not among the assigned shops", async () => {
    const a = await makeShop();
    const b = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [a.id] });

    const error = await updateUser(owner, staff.id, {
      shopIds: [a.id],
      defaultShopId: b.id,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses an inactive shop", async () => {
    const shop = await makeShop();
    const dead = await makeShop();
    await prisma.shop.update({ where: { id: dead.id }, data: { isActive: false } });

    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    const error = await updateUser(owner, staff.id, {
      shopIds: [shop.id, dead.id],
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");
  });
});

// ───────────────────── deactivation and sessions ─────────────────────

describe("deactivation", () => {
  async function giveSession(userId: string) {
    return prisma.session.create({
      data: {
        userId,
        token: `tok-${uniq()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  }

  it("sets banned, records the reason, and destroys live sessions (R-9)", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });
    await giveSession(staff.id);

    const dto = await updateUser(owner, staff.id, {
      isActive: false,
      deactivationReason: "Left the company",
    });

    expect(dto.isActive).toBe(false);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.banned).toBe(true);
    expect(after.banReason).toBe("Left the company");

    // Must take effect now, not in up to 12 hours.
    await expect(
      prisma.session.count({ where: { userId: staff.id } }),
    ).resolves.toBe(0);
  });

  it("defaults the reason rather than storing nothing", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    await updateUser(owner, staff.id, { isActive: false });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.banReason).toBeTruthy();
  });

  it("reactivates and clears the reason", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    await updateUser(owner, staff.id, { isActive: false, deactivationReason: "x" });
    const dto = await updateUser(owner, staff.id, { isActive: true });

    expect(dto.isActive).toBe(true);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.banned).toBe(false);
    expect(after.banReason).toBeNull();
  });

  it("keeps the account's history — deactivation is never a delete", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    await updateUser(owner, staff.id, { isActive: false });

    // The row survives, so past sales and attendance still attribute to them.
    await expect(
      prisma.user.findUnique({ where: { id: staff.id } }),
    ).resolves.not.toBeNull();
    // And they still appear in the admin list, marked inactive.
    const listed = (await listUsers(owner)).find((u) => u.id === staff.id);
    expect(listed?.isActive).toBe(false);
  });
});

// ───────────────────────── password reset ─────────────────────────

describe("resetting a password", () => {
  it("forces a change and destroys every session", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });
    await prisma.session.create({
      data: {
        userId: staff.id,
        token: `tok-${uniq()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await resetUserPassword(owner, staff.id, "TempPass2026!");

    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.mustChangePassword).toBe(true);
    // A reset must evict whoever prompted it.
    await expect(
      prisma.session.count({ where: { userId: staff.id } }),
    ).resolves.toBe(0);
  });

  it("enforces the password policy", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    for (const bad of ["short", "password", "12345678"]) {
      const error = await resetUserPassword(owner, staff.id, bad).catch((e) => e);
      expect(error, `"${bad}" must be rejected`).toBeInstanceOf(AppError);
      expect(error.code).toBe("VALIDATION_FAILED");
    }

    // And none of them flipped the flag.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.mustChangePassword).toBe(false);
  });

  it("never writes the password into the audit log", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    await resetUserPassword(owner, staff.id, "SecretPass2026!");

    const rows = await prisma.auditLog.findMany({
      where: { entity: "User", entityId: staff.id, action: "RESET_PASSWORD" },
    });
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("SecretPass2026!");
  });
});

// ───────────────────────── permissions and immutability ─────────────────────

describe("permissions and immutability", () => {
  it("is OWNER-only", async () => {
    const shop = await makeShop();
    const { actor: manager } = await makeUser("MANAGER", { shops: [shop.id] });
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    for (const call of [
      () => updateUser(manager, staff.id, { displayName: "Hijacked" }),
      () => resetUserPassword(manager, staff.id, "TempPass2026!"),
      () => listUsers(manager),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("FORBIDDEN");
    }

    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.displayName).not.toBe("Hijacked");
  });

  it("cannot change a username (D-3)", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    // The schema strips it — an attempt is a silent no-op on that field.
    const parsed = updateUserSchema.parse({
      username: "hacked",
      displayName: "Renamed",
    });
    expect(parsed).not.toHaveProperty("username");

    await updateUser(owner, staff.id, parsed);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.username).toBe(staff.username);
    expect(after.displayName).toBe("Renamed");
  });

  it("mirrors displayName into Better Auth's `name` field", async () => {
    const shop = await makeShop();
    const { actor: owner } = await makeUser("OWNER");
    const { user: staff } = await makeUser("STAFF", { shops: [shop.id] });

    await updateUser(owner, staff.id, { displayName: "New Name" });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    // Otherwise the library and our UI show different names for one person.
    expect(after.displayName).toBe("New Name");
    expect(after.name).toBe("New Name");
  });

  it("404s on a user that does not exist", async () => {
    const { actor: owner } = await makeUser("OWNER");

    for (const call of [
      () => updateUser(owner, "no-such-user", { displayName: "X" }),
      () => resetUserPassword(owner, "no-such-user", "TempPass2026!"),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("NOT_FOUND");
    }
  });
});
