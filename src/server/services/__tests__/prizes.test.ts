/**
 * Prize catalog and per-shop stocking policy (PRD §4.8, §7.4).
 *
 * The services shipped in Phase 5 with no UI and no tests. D-116 built the
 * Settings → Prizes screen, which makes `createPrize` / `updatePrize` reachable
 * by a MANAGER for the first time — so the rules below are now enforced against
 * real user input rather than the seed script, and need pinning.
 *
 * These write real rows and clean up in `afterEach`, following
 * `shops.test.ts` — the services open their own transactions and call
 * `writeAudit`, so they cannot run inside `withRollback`'s.
 *
 * What is worth proving here rather than assuming:
 *
 *  - **Ticket cost is GLOBAL** (§4.8, a decision CLAUDE.md marks closed).
 *    `shopPrizeConfigSchema` is `.strict()` precisely so a client that tries to
 *    set a per-branch price is REJECTED rather than having the field dropped.
 *    A silent strip is the dangerous failure: the manager believes they set a
 *    branch price that was never stored.
 *  - **A reprice raises an owner alert and an audit row**, because it reaches
 *    branches the editor may not manage. This is §4.8's mitigation and the
 *    reason the UI can warn honestly.
 *  - **A reprice that is not a change must NOT alert** — otherwise every
 *    rename floods the owner's dashboard and the signal is worthless.
 *  - **SKU is unique**, and a collision is a clean 409 rather than a Prisma
 *    crash, because the Add form surfaces the message verbatim.
 *  - **`setShopPrizeConfig` respects shop access**, so a manager cannot stock a
 *    branch they do not manage by typing its id.
 *  - **HQ holds no stock** (§4.12) — it is expense-only, and inventory there
 *    could never be redeemed.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, uniq, makeActorWithUser } from "./helpers";
import {
  createPrize,
  createPrizeSchema,
  listPrizes,
  setShopPrizeConfig,
  shopPrizeConfigSchema,
  updatePrize,
  updatePrizeSchema,
  type UpdatePrizeInput,
} from "../prizes";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

/** Distinctive enough not to collide with the seed, demo seed or verify scripts. */
const TEST_SKU_PREFIX = "ZPRZ";
const TEST_CODE_PREFIX = "ZPRS";

const prizeIds: string[] = [];
const shopIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({
    where: { OR: [{ entityId: { in: prizeIds } }, { userId: { in: userIds } }] },
  });
  await prisma.systemAlert.deleteMany({
    where: { key: { in: prizeIds.map((id) => `TICKET_COST_CHANGED:${id}`) } },
  });
  await prisma.shopPrizeConfig.deleteMany({
    where: { OR: [{ prizeItemId: { in: prizeIds } }, { shopId: { in: shopIds } }] },
  });
  await prisma.prizeBatch.deleteMany({
    where: { OR: [{ prizeItemId: { in: prizeIds } }, { shopId: { in: shopIds } }] },
  });
  await prisma.prizeItem.deleteMany({ where: { id: { in: prizeIds } } });
  // Backstop for a row created but never pushed onto the id list.
  await prisma.prizeItem.deleteMany({
    where: { sku: { startsWith: TEST_SKU_PREFIX } },
  });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });
  await prisma.shop.deleteMany({
    where: { code: { startsWith: TEST_CODE_PREFIX } },
  });

  prizeIds.length = 0;
  shopIds.length = 0;
  userIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeUser(
  role: "OWNER" | "MANAGER" | "STAFF",
  opts: { assignedShopIds?: string[]; canEnterCost?: boolean } = {}
): Promise<Actor> {
  const actor = await makeActorWithUser(prisma as unknown as Prisma.TransactionClient, {
    role,
    shopIds: opts.assignedShopIds ?? [],
    canEnterCost: opts.canEnterCost,
    businessDate: new Date("2026-08-18T00:00:00.000Z"),
  });
  userIds.push(actor.userId);
  return actor;
}

async function makeShop(opts: { isHqPseudoShop?: boolean } = {}) {
  const id = uniq();
  const shop = await prisma.shop.create({
    data: {
      code: `${TEST_CODE_PREFIX}${id.slice(0, 4)}`.toUpperCase(),
      name: `Prize Branch ${id}`,
      timezone: "Asia/Jakarta",
      isHqPseudoShop: opts.isHqPseudoShop ?? false,
    },
  });
  shopIds.push(shop.id);
  return shop;
}

function prizeInput(overrides: Record<string, unknown> = {}) {
  return createPrizeSchema.parse({
    sku: `${TEST_SKU_PREFIX}-${uniq()}`,
    name: `Test Prize ${uniq()}`,
    ticketCost: 100,
    ...overrides,
  });
}

async function create(actor: Actor, overrides: Record<string, unknown> = {}) {
  const prize = await createPrize(actor, prizeInput(overrides));
  prizeIds.push(prize.id);
  return prize;
}

describe("createPrize", () => {
  it("creates a catalog item an owner can then stock", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner, { name: "Teddy", ticketCost: 250 });

    expect(prize.name).toBe("Teddy");
    expect(prize.ticketCost).toBe(250);
    expect(prize.isActive).toBe(true);
  });

  it("lets a MANAGER create one — the route has always allowed it (D-116)", async () => {
    const manager = await makeUser("MANAGER");
    const prize = await create(manager, { name: "Yo-yo" });

    expect(prize.name).toBe("Yo-yo");
  });

  it("starts carried by NO branch, so a new item cannot be redeemed yet", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner);

    const configs = await prisma.shopPrizeConfig.count({
      where: { prizeItemId: prize.id },
    });
    expect(configs).toBe(0);
    // The Add form says exactly this; if the service ever auto-stocked, the
    // message would become a lie.
    expect(prize.shopConfig).toBeNull();
  });

  it("rejects a duplicate SKU with a CONFLICT the form can show", async () => {
    const owner = await makeUser("OWNER");
    const first = await create(owner);

    await expect(
      createPrize(owner, prizeInput({ sku: first.sku }))
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("writes an audit row naming the author", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner);

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: prize.id, action: "PRIZE_CREATE" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.userId).toBe(owner.userId);
  });

  it("refuses a zero or negative ticket cost", () => {
    expect(() => prizeInput({ ticketCost: 0 })).toThrow();
    expect(() => prizeInput({ ticketCost: -5 })).toThrow();
  });

  it("refuses a SKU with characters the URL or CSV would mangle", () => {
    expect(() => prizeInput({ sku: "has space" })).toThrow();
    expect(() => prizeInput({ sku: "has/slash" })).toThrow();
  });
});

describe("updatePrize", () => {
  it("renames without touching the price", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner, { name: "Old", ticketCost: 100 });

    const updated = await updatePrize(owner, prize.id, { name: "New" });
    expect(updated.name).toBe("New");
    expect(updated.ticketCost).toBe(100);
  });

  it("retires an item rather than deleting it", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner);

    const updated = await updatePrize(owner, prize.id, { isActive: false });
    expect(updated.isActive).toBe(false);

    // Still present — past redemptions and live batches reference it.
    const row = await prisma.prizeItem.findUnique({ where: { id: prize.id } });
    expect(row).not.toBeNull();
  });

  it("raises an owner alert on a reprice, because it hits every branch (§4.8)", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner, { ticketCost: 100 });

    await updatePrize(owner, prize.id, { ticketCost: 175 });

    const alert = await prisma.systemAlert.findUnique({
      where: { key: `TICKET_COST_CHANGED:${prize.id}` },
    });
    expect(alert).not.toBeNull();
    expect(alert?.isActive).toBe(true);
    expect(alert?.message).toContain("every branch");
  });

  it("audits the reprice with both the old and the new value", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner, { ticketCost: 100 });

    await updatePrize(owner, prize.id, { ticketCost: 175 });

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: prize.id, action: "PRIZE_TICKET_COST_CHANGE" },
    });
    expect(audit?.before).toMatchObject({ ticketCost: 100 });
    expect(audit?.after).toMatchObject({ ticketCost: 175 });
  });

  it("does NOT alert when the price is unchanged", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner, { ticketCost: 100 });

    // Same number, and a rename alongside it. Either alerting here would mean
    // every edit floods the dashboard and the real repricing signal is lost.
    await updatePrize(owner, prize.id, { ticketCost: 100, name: "Renamed" });

    const alert = await prisma.systemAlert.findUnique({
      where: { key: `TICKET_COST_CHANGED:${prize.id}` },
    });
    expect(alert).toBeNull();
  });

  it("collapses repeated repricing into ONE alert row per prize", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner, { ticketCost: 100 });

    await updatePrize(owner, prize.id, { ticketCost: 120 });
    await updatePrize(owner, prize.id, { ticketCost: 140 });

    const alerts = await prisma.systemAlert.count({
      where: { key: `TICKET_COST_CHANGED:${prize.id}` },
    });
    expect(alerts).toBe(1);
  });

  it("clears the category when sent null", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner, { category: "Plush" });

    const updated = await updatePrize(owner, prize.id, { category: null });
    expect(updated.category).toBeNull();
  });

  it("404s on a prize that no longer exists", async () => {
    const owner = await makeUser("OWNER");
    await expect(
      updatePrize(owner, "no-such-prize-id", { name: "x" })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("refuses an empty patch rather than writing a no-op audit row", () => {
    expect(() => updatePrizeSchema.parse({})).toThrow();
  });

  it("does not accept a SKU change — it is immutable after creation", async () => {
    const owner = await makeUser("OWNER");
    const prize = await create(owner);
    const original = prize.sku;

    // Not in the schema, so it is stripped rather than applied. The cast goes
    // through `unknown` because that is exactly the point of the test: the
    // extra key is not assignable, and a caller could only smuggle it by
    // deliberately lying to the compiler.
    await updatePrize(owner, prize.id, {
      name: "Renamed",
      sku: `${TEST_SKU_PREFIX}-hijack`,
    } as unknown as UpdatePrizeInput);

    const row = await prisma.prizeItem.findUnique({ where: { id: prize.id } });
    expect(row?.sku).toBe(original);
  });
});

describe("setShopPrizeConfig — the global-price boundary", () => {
  it("REJECTS a per-shop ticketCost rather than silently stripping it", () => {
    // The whole point of `.strict()`. If this ever starts passing, a manager
    // can believe they set a branch price that was never stored (§4.8).
    expect(() =>
      shopPrizeConfigSchema.parse({
        lowStockThreshold: 5,
        isActive: true,
        ticketCost: 999,
      })
    ).toThrow();
  });

  it("stocks an item at a branch", async () => {
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);

    const config = await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 5,
      isActive: true,
    });

    expect(config.isActive).toBe(true);
    expect(config.lowStockThreshold).toBe(5);
  });

  it("is an upsert — stocking twice updates rather than duplicating", async () => {
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);

    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 5,
      isActive: true,
    });
    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 12,
      isActive: false,
    });

    const rows = await prisma.shopPrizeConfig.findMany({
      where: { shopId: shop.id, prizeItemId: prize.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lowStockThreshold).toBe(12);
    expect(rows[0]?.isActive).toBe(false);
  });

  it("stops a MANAGER stocking a branch they do not manage", async () => {
    const owner = await makeUser("OWNER");
    const mine = await makeShop();
    const theirs = await makeShop();
    const prize = await create(owner);
    const manager = await makeUser("MANAGER", { assignedShopIds: [mine.id] });

    await expect(
      setShopPrizeConfig(manager, theirs.id, prize.id, {
        lowStockThreshold: 5,
        isActive: true,
      })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("lets a MANAGER stock a branch they DO manage", async () => {
    const owner = await makeUser("OWNER");
    const mine = await makeShop();
    const prize = await create(owner);
    const manager = await makeUser("MANAGER", { assignedShopIds: [mine.id] });

    const config = await setShopPrizeConfig(manager, mine.id, prize.id, {
      lowStockThreshold: 3,
      isActive: true,
    });
    expect(config.isActive).toBe(true);
  });

  it("refuses to stock HQ, which holds no inventory (§4.12)", async () => {
    const owner = await makeUser("OWNER");
    const hq = await makeShop({ isHqPseudoShop: true });
    const prize = await create(owner);

    await expect(
      setShopPrizeConfig(owner, hq.id, prize.id, {
        lowStockThreshold: 5,
        isActive: true,
      })
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("carrying an item at a branch (D-117)", () => {
  it("received stock is INVISIBLE on On hand until the branch carries the item", async () => {
    // The reason the Catalog tab exists. `receiveBatch` never writes a
    // `ShopPrizeConfig`, and the On hand tab filters by `shopConfig?.isActive`
    // — so before D-117 a delivery could be booked and then not appear, with
    // no screen anywhere able to fix it.
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);

    await prisma.prizeBatch.create({
      data: {
        shopId: shop.id,
        prizeItemId: prize.id,
        qtyReceived: 10,
        qtyRemaining: 10,
        unitCogs: new Prisma.Decimal(1000),
        needsCosting: false,
        receivedAt: new Date(),
      },
    });

    const before = await listPrizes(owner, {
      shopId: shop.id,
      includeUnstocked: true,
    });
    const beforeRow = before.find((p) => p.id === prize.id);
    // The stock is really there...
    expect(beforeRow?.onHand).toBe(10);
    // ...but nothing marks the branch as carrying it, which is what On hand
    // and the redemption screen (§4.9) both filter on.
    expect(beforeRow?.shopConfig).toBeNull();

    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 3,
      isActive: true,
    });

    const after = await listPrizes(owner, {
      shopId: shop.id,
      includeUnstocked: true,
    });
    const afterRow = after.find((p) => p.id === prize.id);
    expect(afterRow?.shopConfig?.isActive).toBe(true);
    expect(afterRow?.onHand).toBe(10);
  });

  it("stopping carrying an item does NOT destroy its stock", async () => {
    // The toast says the stock stays on the shelf. If the service ever started
    // voiding batches here, that message would be a lie and the branch would
    // silently lose inventory.
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);

    await prisma.prizeBatch.create({
      data: {
        shopId: shop.id,
        prizeItemId: prize.id,
        qtyReceived: 7,
        qtyRemaining: 7,
        unitCogs: new Prisma.Decimal(500),
        needsCosting: false,
        receivedAt: new Date(),
      },
    });
    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 2,
      isActive: true,
    });

    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 2,
      isActive: false,
    });

    const rows = await listPrizes(owner, {
      shopId: shop.id,
      includeUnstocked: true,
    });
    const row = rows.find((p) => p.id === prize.id);
    expect(row?.shopConfig?.isActive).toBe(false);
    expect(row?.onHand).toBe(7);
  });

  it("the low-stock flag follows the threshold the branch set", async () => {
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);

    await prisma.prizeBatch.create({
      data: {
        shopId: shop.id,
        prizeItemId: prize.id,
        qtyReceived: 4,
        qtyRemaining: 4,
        unitCogs: new Prisma.Decimal(100),
        needsCosting: false,
        receivedAt: new Date(),
      },
    });

    // Below the threshold → flagged.
    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 5,
      isActive: true,
    });
    let rows = await listPrizes(owner, { shopId: shop.id, includeUnstocked: true });
    expect(rows.find((p) => p.id === prize.id)?.isLowStock).toBe(true);

    // Raised above on-hand → no longer flagged. This is the whole point of
    // making the threshold editable per branch.
    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 2,
      isActive: true,
    });
    rows = await listPrizes(owner, { shopId: shop.id, includeUnstocked: true });
    expect(rows.find((p) => p.id === prize.id)?.isLowStock).toBe(false);

    // 0 means "never warn" (§4.8), even at low stock.
    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 0,
      isActive: true,
    });
    rows = await listPrizes(owner, { shopId: shop.id, includeUnstocked: true });
    expect(rows.find((p) => p.id === prize.id)?.isLowStock).toBe(false);
  });
});

describe("listPrizes — what the catalog screen reads", () => {
  it("includeUnstocked shows items this branch does not carry", async () => {
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);

    // The catalog screen depends on this: without the flag a newly created
    // item is invisible everywhere and could never be edited or stocked.
    const withFlag = await listPrizes(owner, {
      shopId: shop.id,
      includeUnstocked: true,
    });
    expect(withFlag.map((p) => p.id)).toContain(prize.id);

    const withoutFlag = await listPrizes(owner, { shopId: shop.id });
    expect(withoutFlag.map((p) => p.id)).not.toContain(prize.id);
  });

  it("reports shopConfig null for an item the branch never configured", async () => {
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);

    const rows = await listPrizes(owner, {
      shopId: shop.id,
      includeUnstocked: true,
    });
    const row = rows.find((p) => p.id === prize.id);

    // The row distinguishes "not carried" from "carried, zero left" — the UI
    // renders different sentences for the two.
    expect(row?.shopConfig).toBeNull();
    expect(row?.onHand).toBe(0);
    expect(row?.isLowStock).toBe(false);
  });

  it("does not flag low stock when the threshold is 0 (§4.8: 0 means no alert)", async () => {
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);

    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 0,
      isActive: true,
    });

    const rows = await listPrizes(owner, {
      shopId: shop.id,
      includeUnstocked: true,
    });
    const row = rows.find((p) => p.id === prize.id);
    expect(row?.onHand).toBe(0);
    expect(row?.isLowStock).toBe(false);
  });

  it("stops a MANAGER reading a branch they do not manage", async () => {
    const owner = await makeUser("OWNER");
    const theirs = await makeShop();
    const mine = await makeShop();
    const manager = await makeUser("MANAGER", { assignedShopIds: [mine.id] });
    await create(owner);

    await expect(
      listPrizes(manager, { shopId: theirs.id, includeUnstocked: true })
    ).rejects.toBeInstanceOf(AppError);
  });

  it("gives a plain MANAGER no cost fields at all (§7.5)", async () => {
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);
    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 5,
      isActive: true,
    });

    const manager = await makeUser("MANAGER", {
      assignedShopIds: [shop.id],
      canEnterCost: false,
    });
    const rows = await listPrizes(manager, {
      shopId: shop.id,
      includeUnstocked: true,
    });
    const row = rows.find((p) => p.id === prize.id);

    // Not "undefined" — absent. The restricted builder never reads the column.
    expect(row).not.toHaveProperty("stockValuation");
    expect(row).not.toHaveProperty("uncostedBatchCount");
  });

  it("gives a PURCHASING manager the cost view at their own shop", async () => {
    const owner = await makeUser("OWNER");
    const shop = await makeShop();
    const prize = await create(owner);
    await setShopPrizeConfig(owner, shop.id, prize.id, {
      lowStockThreshold: 5,
      isActive: true,
    });

    const purchasing = await makeUser("MANAGER", {
      assignedShopIds: [shop.id],
      canEnterCost: true,
    });
    const rows = await listPrizes(purchasing, {
      shopId: shop.id,
      includeUnstocked: true,
    });
    const row = rows.find((p) => p.id === prize.id);

    expect(row).toHaveProperty("stockValuation");
  });
});
