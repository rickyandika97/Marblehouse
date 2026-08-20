/**
 * Shop administration (PRD §5.6, §3.4; BUILD-LOG D-101).
 *
 * These write real rows and clean up in `afterEach`, following
 * `expenses.test.ts` — the service opens its own transactions and calls
 * `writeAudit`, so it cannot run inside `withRollback`'s.
 *
 * What is worth proving here rather than assuming:
 *
 *  - **OWNER-only, on every function.** §3.4 gives "Create / edit shop" to the
 *    owner alone, and hiding the menu item is not the control.
 *  - **A new shop starts EMPTY** (D-101). This is the decision the owner took
 *    against §5.6's clone step, so it is the thing most likely to be "fixed"
 *    back by a later session. A test pins it.
 *  - **The code is unique, case-insensitively.** Postgres uniqueness is
 *    case-sensitive, so `br-2` and `BR-2` would both be accepted without the
 *    schema's `.toUpperCase()`, and every report would read as one branch.
 *  - **The last active branch cannot be retired**, and neither can HQ. Both
 *    lock the owner out of something with no obvious cause.
 *  - **`code` and `isHqPseudoShop` are immutable** — absent from the update
 *    schema, and an attempt to send them must not take effect.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, uniq, makeActorWithUser } from "./helpers";
import {
  addDefaultPresets,
  createPreset,
  createPresetSchema,
  createShop,
  createShopSchema,
  deletePreset,
  getShop,
  listPresetsForAdmin,
  listShops,
  updatePreset,
  updateShop,
  updateShopSchema,
} from "../shops";
import { listPresets } from "../sales";
import { listShopStaff, setShopAssignment } from "../employees";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

/**
 * Every shop this file creates carries this prefix, so `afterEach` can sweep
 * up anything that escaped the id list. Distinctive enough not to collide with
 * the seed (`BR-1`, `HQ`), the demo seed, or the verify scripts.
 */
const TEST_CODE_PREFIX = "ZTST";

const testCode = () => `${TEST_CODE_PREFIX}${uniq().slice(0, 5)}`.toUpperCase();

const shopIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: shopIds } }, { userId: { in: userIds } }] },
  });
  await prisma.sale.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.salePreset.deleteMany({ where: { shopId: { in: shopIds } } });
  // Backstop: a shop created by `createShop` but never pushed onto `shopIds`
  // (a throw between the two) would otherwise leak into the dev database and
  // count towards the "last active branch" check in a later run.
  await prisma.sale.deleteMany({
    where: { shop: { code: { startsWith: TEST_CODE_PREFIX } } },
  });
  await prisma.salePreset.deleteMany({
    where: { shop: { code: { startsWith: TEST_CODE_PREFIX } } },
  });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
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

async function makeUser(role: "OWNER" | "MANAGER" | "STAFF"): Promise<Actor> {
  const actor = await makeActorWithUser(prisma as unknown as Prisma.TransactionClient, {
    role,
    businessDate: new Date("2026-08-18T00:00:00.000Z"),
  });
  userIds.push(actor.userId);
  return actor;
}

/**
 * A STAFF user row assigned to the given shops. Distinct from `makeUser`,
 * which builds an Actor to act AS; these tests act ON a person.
 */
async function makeStaff(shopIds: string[]) {
  const id = uniq();
  const user = await prisma.user.create({
    data: {
      email: `stf-${id}@marblehouse.invalid`,
      name: `Stf ${id}`,
      username: `stf-${id}`,
      displayName: `Stf ${id}`,
      defaultShopId: shopIds[0] ?? null,
    },
  });
  userIds.push(user.id);
  for (const shopId of shopIds) {
    await prisma.userShop.create({
      data: { userId: user.id, shopId, role: "STAFF" },
    });
  }
  return user;
}

/** Valid input with a code that cannot collide with the seed or another test. */
function shopInput(overrides: Record<string, unknown> = {}) {
  return createShopSchema.parse({
    code: testCode(),
    name: `Test Branch ${uniq()}`,
    ...overrides,
  });
}

async function create(actor: Actor, overrides: Record<string, unknown> = {}) {
  const shop = await createShop(actor, shopInput(overrides));
  shopIds.push(shop.id);
  return shop;
}

// ───────────────────────── the empty-start decision ─────────────────────────

describe("a new shop starts empty (D-101)", () => {
  it("creates no presets and no shifts", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    // Through the DTO...
    expect(shop.presetCount).toBe(0);
    expect(shop.shiftCount).toBe(0);

    // ...and in the database, in case the DTO ever lies.
    await expect(
      prisma.salePreset.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.shift.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(0);
  });

  it("copies nothing from an existing shop that has presets", async () => {
    const owner = await makeUser("OWNER");

    const source = await create(owner);
    await prisma.salePreset.create({
      data: { shopId: source.id, label: "50k", amount: "50000", sortOrder: 0 },
    });

    const fresh = await create(owner);

    expect(fresh.presetCount).toBe(0);
    await expect(
      prisma.salePreset.count({ where: { shopId: fresh.id } }),
    ).resolves.toBe(0);
  });

  it("assigns nobody to the new shop", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    await expect(
      prisma.userShop.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(0);
  });
});

// ───────────────────────────── permissions ─────────────────────────────

describe("OWNER only (§3.4)", () => {
  it("refuses create to a MANAGER and a STAFF", async () => {
    for (const role of ["MANAGER", "STAFF"] as const) {
      const actor = await makeUser(role);
      const error = await createShop(actor, shopInput()).catch((e) => e);

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("FORBIDDEN");
      expect(error.status).toBe(403);
    }
  });

  it("refuses list, get and update to a MANAGER", async () => {
    const owner = await makeUser("OWNER");
    const manager = await makeUser("MANAGER");
    const shop = await create(owner);

    for (const call of [
      () => listShops(manager),
      () => getShop(manager, shop.id),
      () => updateShop(manager, shop.id, { name: "Renamed" }),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("FORBIDDEN");
    }

    // And the refused update really did not land.
    const after = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(after.name).toBe(shop.name);
  });
});

// ─────────────────────────── the unique code ───────────────────────────

describe("the branch code", () => {
  it("is uppercased, so two casings cannot both exist", async () => {
    const owner = await makeUser("OWNER");
    const code = testCode();

    const shop = await create(owner, { code: code.toLowerCase() });
    expect(shop.code).toBe(code.toUpperCase());

    const error = await createShop(
      owner,
      shopInput({ code: code.toUpperCase() }),
    ).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);
  });

  it("rejects a code with spaces or punctuation", async () => {
    const bad = createShopSchema.safeParse({ code: "BR 2!", name: "Nope" });
    expect(bad.success).toBe(false);
  });

  it("cannot be changed by an update", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    // The schema strips it — an attempt to rename the code is a silent no-op
    // on that field, not an error, and must leave the original standing.
    const parsed = updateShopSchema.parse({ code: "HACKED", name: "Renamed" });
    expect(parsed).not.toHaveProperty("code");

    const updated = await updateShop(owner, shop.id, parsed);
    expect(updated.code).toBe(shop.code);
    expect(updated.name).toBe("Renamed");
  });
});

// ──────────────────────────── deactivation ────────────────────────────

describe("deactivating a shop", () => {
  it("refuses to retire the last active branch", async () => {
    const owner = await makeUser("OWNER");

    // The dev database always has at least the seed's BR-1, so retire every
    // other active branch first to reach the genuine last-one state.
    const actives = await prisma.shop.findMany({
      where: { isActive: true, isHqPseudoShop: false },
      select: { id: true },
    });
    expect(actives.length).toBeGreaterThan(0);

    const [survivor, ...rest] = actives;
    if (!survivor) throw new Error("expected at least one active branch");
    for (const s of rest) {
      await prisma.shop.update({ where: { id: s.id }, data: { isActive: false } });
    }

    try {
      const error = await updateShop(owner, survivor.id, {
        isActive: false,
      }).catch((e) => e);

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.message).toContain("last active branch");

      // It must still be open.
      const after = await prisma.shop.findUniqueOrThrow({
        where: { id: survivor.id },
      });
      expect(after.isActive).toBe(true);
    } finally {
      // Restore every branch this test closed, whatever happened above —
      // INCLUDING the survivor, which stays shut if the guard is ever broken
      // (as the mutation check breaks it on purpose). Leaving a seed branch
      // deactivated breaks every later run in a way that reads as a new bug.
      await prisma.shop.updateMany({
        where: { id: { in: [survivor.id, ...rest.map((s) => s.id)] } },
        data: { isActive: true },
      });
    }
  });

  it("allows it while another branch is still open, and can reopen", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const closed = await updateShop(owner, shop.id, { isActive: false });
    expect(closed.isActive).toBe(false);

    const reopened = await updateShop(owner, shop.id, { isActive: true });
    expect(reopened.isActive).toBe(true);
  });

  it("refuses to deactivate HQ", async () => {
    const owner = await makeUser("OWNER");

    const hq = await prisma.shop.findFirst({ where: { isHqPseudoShop: true } });
    expect(hq, "the seed's HQ pseudo-shop must exist").not.toBeNull();

    try {
      const error = await updateShop(owner, hq!.id, { isActive: false }).catch(
        (e) => e,
      );

      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.message).toContain("HQ");

      const after = await prisma.shop.findUniqueOrThrow({
        where: { id: hq!.id },
      });
      expect(after.isActive).toBe(true);
    } finally {
      // This test asks the service to close a SEED row. If the guard is ever
      // broken — which is exactly what the mutation check does on purpose —
      // the call succeeds and HQ stays shut, breaking every later run and
      // every expense screen. Restore it unconditionally.
      await prisma.shop.update({
        where: { id: hq!.id },
        data: { isActive: true },
      });
    }
  });
});

// ──────────────────────────── HQ is not mintable ────────────────────────────

describe("isHqPseudoShop", () => {
  it("is never set by create, even if the caller sends it", async () => {
    const owner = await makeUser("OWNER");

    const parsed = createShopSchema.parse({
      code: testCode(),
      name: "Sneaky HQ",
      isHqPseudoShop: true,
    });
    expect(parsed).not.toHaveProperty("isHqPseudoShop");

    const shop = await createShop(owner, parsed);
    shopIds.push(shop.id);

    expect(shop.isHqPseudoShop).toBe(false);
  });
});

// ──────────────────────────── audit and defaults ────────────────────────────

describe("audit and defaults", () => {
  it("writes a CREATE audit row against the new shop", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const row = await prisma.auditLog.findFirst({
      where: { entity: "Shop", entityId: shop.id, action: "CREATE" },
    });

    expect(row).not.toBeNull();
    // Attributed to the NEW shop, not the owner's own work session.
    expect(row!.shopId).toBe(shop.id);
    expect(row!.userId).toBe(owner.userId);
  });

  it("writes before and after on an update", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner, { lateGraceMin: 5 });

    await updateShop(owner, shop.id, { lateGraceMin: 20 });

    const row = await prisma.auditLog.findFirst({
      where: { entity: "Shop", entityId: shop.id, action: "UPDATE" },
      orderBy: { occurredAt: "desc" },
    });

    expect(row).not.toBeNull();
    expect((row!.before as { lateGraceMin: number }).lateGraceMin).toBe(5);
    expect((row!.after as { lateGraceMin: number }).lateGraceMin).toBe(20);
  });

  it("defaults grace to 5 minutes and the toggles to off", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    expect(shop.lateGraceMin).toBe(5);
    expect(shop.allowCustomAmount).toBe(false);
    expect(shop.allowDirectTransfer).toBe(false);
    expect(shop.requireClockOutPhoto).toBe(false);
    expect(shop.isActive).toBe(true);
  });

  it("rejects an unrecognised timezone", async () => {
    const bad = createShopSchema.safeParse({
      code: "BR-9",
      name: "Nowhere",
      timezone: "Mars/Olympus",
    });
    expect(bad.success).toBe(false);
  });
});

// ═══════════════════════ Sale presets (§4.3, D-103) ═══════════════════════
//
// The rule under test, and the reason this block is long:
//
//   "A preset that has been used in a sale can be deactivated but never
//    deleted or edited in a way that changes its amount." (§4.3)
//
// A Sale stores `presetId`, not a copy of the amount. Editing 50.000 to 60.000
// in place would therefore silently restate every historical sale pointing at
// it — last month's revenue would change with no audit trail explaining why.
// That is a money bug of exactly the kind CLAUDE.md says needs a test before
// the work closes.

/** A sale against a preset, so the "has been used" branch can be exercised. */
async function sellOnce(shopId: string, presetId: string, amount: string) {
  const owner = await prisma.user.findFirstOrThrow({ where: { isOwner: true } });
  return prisma.sale.create({
    data: {
      shopId,
      recordedById: owner.id,
      presetId,
      amount,
      paymentMethod: "CASH",
      businessDate: new Date("2026-08-18T00:00:00.000Z"),
    },
  });
}

describe("sale presets — the empty branch is fillable (D-103)", () => {
  it("adds the five documented defaults on a shop with none", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const presets = await addDefaultPresets(owner, shop.id);

    expect(presets).toHaveLength(5);
    expect(presets.map((p) => p.amount)).toEqual([
      "20000",
      "50000",
      "100000",
      "200000",
      "500000",
    ]);
    // In the owner's chosen order, not alphabetical by label.
    expect(presets.map((p) => p.sortOrder)).toEqual([1, 2, 3, 4, 5]);
    expect(presets.every((p) => p.isActive)).toBe(true);
  });

  it("refuses to add defaults twice", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    await addDefaultPresets(owner, shop.id);
    const error = await addDefaultPresets(owner, shop.id).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("CONFLICT");

    // And it did not half-apply.
    await expect(
      prisma.salePreset.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(5);
  });

  it("creates a single preset, appended to the end of the list", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const first = await createPreset(owner, shop.id, {
      label: "Rp 25.000",
      amount: "25000",
    });
    const second = await createPreset(owner, shop.id, {
      label: "Rp 75.000",
      amount: "75000",
    });

    // A new price must not jump to the front of the till.
    expect(second.sortOrder).toBeGreaterThan(first.sortOrder);
  });

  it("rejects a duplicate active amount at the same shop", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    await createPreset(owner, shop.id, { label: "Rp 50.000", amount: "50000" });
    const error = await createPreset(owner, shop.id, {
      label: "Fifty again",
      amount: "50000",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("CONFLICT");
  });

  it("allows the same amount at a DIFFERENT shop", async () => {
    const owner = await makeUser("OWNER");
    const a = await create(owner);
    const b = await create(owner);

    await createPreset(owner, a.id, { label: "Rp 50.000", amount: "50000" });
    // Presets are per shop (§4.3) — this must not collide.
    await expect(
      createPreset(owner, b.id, { label: "Rp 50.000", amount: "50000" }),
    ).resolves.toMatchObject({ amount: "50000" });
  });

  it("rejects zero, negative and non-numeric amounts", async () => {
    for (const amount of ["0", "000", "-5000", "5000.50", "abc", ""]) {
      const parsed = createPresetSchema.safeParse({ label: "X", amount });
      expect(parsed.success, `"${amount}" must be rejected`).toBe(false);
    }
  });
});

describe("§4.3 — a preset with sales against it", () => {
  it("SUPERSEDES rather than re-pricing, so past sales keep their amount", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const preset = await createPreset(owner, shop.id, {
      label: "Rp 50.000",
      amount: "50000",
    });
    const sale = await sellOnce(shop.id, preset.id, "50000");

    const result = await updatePreset(owner, shop.id, preset.id, {
      amount: "60000",
    });

    // A NEW row, not the old one edited.
    expect(result.id).not.toBe(preset.id);
    expect(result.amount).toBe("60000");
    expect(result.supersededId).toBe(preset.id);

    // THE POINT: the old preset still exists, still holds 50000, and the
    // historical sale still points at it with its original amount.
    const old = await prisma.salePreset.findUniqueOrThrow({
      where: { id: preset.id },
    });
    expect(old.amount.toString()).toBe("50000");
    expect(old.isActive).toBe(false); // retired, never deleted

    const historical = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
    });
    expect(historical.presetId).toBe(preset.id);
    expect(historical.amount.toString()).toBe("50000");
  });

  it("edits in place when the amount does NOT change", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const preset = await createPreset(owner, shop.id, {
      label: "Rp 50.000",
      amount: "50000",
    });
    await sellOnce(shop.id, preset.id, "50000");

    // Relabelling a sold preset is safe — the amount is what history depends on.
    const result = await updatePreset(owner, shop.id, preset.id, {
      label: "Standard play",
    });

    expect(result.id).toBe(preset.id);
    expect(result.supersededId).toBeUndefined();
    expect(result.label).toBe("Standard play");
    expect(result.amount).toBe("50000");
  });

  it("edits the amount in place when the preset was NEVER sold", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const preset = await createPreset(owner, shop.id, {
      label: "Typo",
      amount: "5000",
    });

    // Nothing points at it, so there is no history to protect.
    const result = await updatePreset(owner, shop.id, preset.id, {
      amount: "50000",
    });

    expect(result.id).toBe(preset.id);
    expect(result.supersededId).toBeUndefined();
    expect(result.amount).toBe("50000");
    await expect(
      prisma.salePreset.count({ where: { shopId: shop.id } }),
    ).resolves.toBe(1);
  });

  it("refuses to DELETE it, and names the count", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const preset = await createPreset(owner, shop.id, {
      label: "Rp 50.000",
      amount: "50000",
    });
    await sellOnce(shop.id, preset.id, "50000");
    await sellOnce(shop.id, preset.id, "50000");

    const error = await deletePreset(owner, shop.id, preset.id).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("CONFLICT");
    expect(error.status).toBe(409);
    // The count is what makes the refusal actionable.
    expect(error.details.usageCount).toBe(2);
    expect(error.message).toContain("Deactivate");

    // Still there.
    await expect(
      prisma.salePreset.findUnique({ where: { id: preset.id } }),
    ).resolves.not.toBeNull();
  });

  it("CAN be deactivated, and stops appearing on the sale screen", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const preset = await createPreset(owner, shop.id, {
      label: "Rp 50.000",
      amount: "50000",
    });
    await sellOnce(shop.id, preset.id, "50000");

    await updatePreset(owner, shop.id, preset.id, { isActive: false });

    // The sale screen's own query must no longer offer it...
    const onSaleScreen = await listPresets(shop.id);
    expect(onSaleScreen.map((p) => p.id)).not.toContain(preset.id);

    // ...but the admin list still shows it, marked retired.
    const admin = await listPresetsForAdmin(owner, shop.id);
    expect(admin.find((p) => p.id === preset.id)?.isActive).toBe(false);
  });

  it("deletes outright when nothing has used it (§13.5)", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);

    const preset = await createPreset(owner, shop.id, {
      label: "Mistake",
      amount: "12345",
    });

    await expect(deletePreset(owner, shop.id, preset.id)).resolves.toEqual({
      deleted: true,
    });
    await expect(
      prisma.salePreset.findUnique({ where: { id: preset.id } }),
    ).resolves.toBeNull();
  });
});

describe("preset permissions and scoping", () => {
  it("is OWNER-only on every operation", async () => {
    const owner = await makeUser("OWNER");
    const manager = await makeUser("MANAGER");
    const shop = await create(owner);
    const preset = await createPreset(owner, shop.id, {
      label: "Rp 50.000",
      amount: "50000",
    });

    for (const call of [
      () => listPresetsForAdmin(manager, shop.id),
      () => createPreset(manager, shop.id, { label: "X", amount: "10000" }),
      () => updatePreset(manager, shop.id, preset.id, { label: "X" }),
      () => deletePreset(manager, shop.id, preset.id),
      () => addDefaultPresets(manager, shop.id),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("FORBIDDEN");
    }

    // Nothing the manager attempted took effect.
    const after = await prisma.salePreset.findMany({ where: { shopId: shop.id } });
    expect(after).toHaveLength(1);
    expect(after[0]!.label).toBe("Rp 50.000");
  });

  it("will not touch a preset belonging to another shop", async () => {
    const owner = await makeUser("OWNER");
    const a = await create(owner);
    const b = await create(owner);

    const preset = await createPreset(owner, a.id, {
      label: "Rp 50.000",
      amount: "50000",
    });

    // Right preset id, wrong shop in the path — must be a 404, not a silent
    // cross-shop edit.
    const error = await updatePreset(owner, b.id, preset.id, {
      label: "Hijacked",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("NOT_FOUND");

    const untouched = await prisma.salePreset.findUniqueOrThrow({
      where: { id: preset.id },
    });
    expect(untouched.label).toBe("Rp 50.000");
  });

  it("404s on a shop that does not exist", async () => {
    const owner = await makeUser("OWNER");
    const error = await listPresetsForAdmin(owner, "no-such-shop").catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("NOT_FOUND");
  });
});

// ═══════════════ Staff assignment, per shop (§5.6, §7.9; D-107) ═══════════════
//
// The same `UserShop` rows `updateUser` manages, reached from the shop. What is
// worth proving:
//
//  - **Nobody is ever stranded with zero shops.** A MANAGER or STAFF with no
//    assignment logs in to an empty picker and can do nothing at all.
//  - **One pair at a time.** Unassigning at one shop must not disturb the
//    user's other branches — the whole reason this is not a whole-array PATCH.
//  - **The default shop follows.** `defaultShopId` drives the actor's timezone
//    and must never point at a branch the user no longer works at.
//  - **OWNERs are never assigned.** They reach every shop already (§3.1).

describe("staff assignment from the shop (D-107)", () => {
  it("assigns and unassigns one person", async () => {
    const owner = await makeUser("OWNER");
    const a = await create(owner);
    const b = await create(owner);
    const staff = await makeStaff([a.id, b.id]);

    let list = await listShopStaff(owner, a.id);
    expect(list.assigned.map((u) => u.id)).toContain(staff.id);

    await setShopAssignment(owner, a.id, staff.id, false);

    list = await listShopStaff(owner, a.id);
    expect(list.assigned.map((u) => u.id)).not.toContain(staff.id);
    expect(list.available.map((u) => u.id)).toContain(staff.id);

    await setShopAssignment(owner, a.id, staff.id, true);
    list = await listShopStaff(owner, a.id);
    expect(list.assigned.map((u) => u.id)).toContain(staff.id);
  });

  it("REFUSES to remove someone from their only shop", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);
    const staff = await makeStaff([shop.id]);

    const error = await setShopAssignment(owner, shop.id, staff.id, false).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toContain("only at this branch");

    // Still assigned — an empty picker is not a state they can be left in.
    await expect(
      prisma.userShop.count({ where: { userId: staff.id } }),
    ).resolves.toBe(1);
  });

  it("leaves the user's OTHER shops untouched", async () => {
    const owner = await makeUser("OWNER");
    const a = await create(owner);
    const b = await create(owner);
    const c = await create(owner);
    const staff = await makeStaff([a.id, b.id, c.id]);

    await setShopAssignment(owner, b.id, staff.id, false);

    const remaining = await prisma.userShop.findMany({
      where: { userId: staff.id },
      select: { shopId: true },
    });
    // Exactly one removed, the other two intact — this is the whole point of
    // a per-pair endpoint over a whole-array replace.
    expect(remaining.map((r) => r.shopId).sort()).toEqual([a.id, c.id].sort());
  });

  it("moves the default shop when the user is unassigned from it", async () => {
    const owner = await makeUser("OWNER");
    const a = await create(owner);
    const b = await create(owner);
    const staff = await makeStaff([a.id, b.id]);
    await prisma.user.update({
      where: { id: staff.id },
      data: { defaultShopId: a.id },
    });

    await setShopAssignment(owner, a.id, staff.id, false);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: staff.id } });
    // Must not still point at a branch they no longer work at — it drives
    // their business-date timezone.
    expect(after.defaultShopId).toBe(b.id);
  });

  it("is idempotent — assigning twice is not an error or a duplicate", async () => {
    const owner = await makeUser("OWNER");
    const a = await create(owner);
    const b = await create(owner);
    const staff = await makeStaff([a.id]);

    await setShopAssignment(owner, b.id, staff.id, true);
    await expect(
      setShopAssignment(owner, b.id, staff.id, true),
    ).resolves.toMatchObject({ assigned: true });

    await expect(
      prisma.userShop.count({ where: { userId: staff.id, shopId: b.id } }),
    ).resolves.toBe(1);
  });

  it("refuses to assign an OWNER", async () => {
    const owner = await makeUser("OWNER");
    const other = await makeUser("OWNER");
    const shop = await create(owner);

    const error = await setShopAssignment(owner, shop.id, other.userId, true).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("VALIDATION_FAILED");
  });

  it("never lists OWNERs as assignable", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);
    await makeStaff([shop.id]);

    const list = await listShopStaff(owner, shop.id);
    const everyone = [...list.assigned, ...list.available];
    expect(everyone.every((u) => !u.isOwner)).toBe(true);
  });

  it("flags the only-shop case so the UI can explain it", async () => {
    const owner = await makeUser("OWNER");
    const a = await create(owner);
    const b = await create(owner);
    const solo = await makeStaff([a.id]);
    const both = await makeStaff([a.id, b.id]);

    const list = await listShopStaff(owner, a.id);
    expect(list.assigned.find((u) => u.id === solo.id)?.isOnlyShop).toBe(true);
    expect(list.assigned.find((u) => u.id === both.id)?.isOnlyShop).toBe(false);
  });

  it("revokes live sessions when access is removed (R-9)", async () => {
    const owner = await makeUser("OWNER");
    const a = await create(owner);
    const b = await create(owner);
    const staff = await makeStaff([a.id, b.id]);

    await prisma.session.create({
      data: {
        userId: staff.id,
        token: `tok-${uniq()}`,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await setShopAssignment(owner, a.id, staff.id, false);

    // Revoking a branch must take effect now, not in up to 12 hours.
    await expect(
      prisma.session.count({ where: { userId: staff.id } }),
    ).resolves.toBe(0);
  });

  it("is OWNER-only", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);
    const staff = await makeStaff([shop.id]);
    const manager = await makeUser("MANAGER");

    for (const call of [
      () => listShopStaff(manager, shop.id),
      () => setShopAssignment(manager, shop.id, staff.id, false),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("FORBIDDEN");
    }
  });

  it("404s on a shop or user that does not exist", async () => {
    const owner = await makeUser("OWNER");
    const shop = await create(owner);
    const staff = await makeStaff([shop.id]);

    for (const call of [
      () => listShopStaff(owner, "no-such-shop"),
      () => setShopAssignment(owner, "no-such-shop", staff.id, true),
      () => setShopAssignment(owner, shop.id, "no-such-user", true),
    ]) {
      const error = await call().catch((e) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error.code).toBe("NOT_FOUND");
    }
  });
});
