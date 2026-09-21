/**
 * Owner sale editing and un-voiding (D-181).
 *
 * These write real rows and clean up in `afterEach`, following
 * `expenses.test.ts` — `updateSale` and `unvoidSale` open their own
 * transactions, so they cannot run inside `withRollback`'s.
 *
 * What is worth proving here rather than assuming. Each of these is either a
 * money invariant or a permission, which CLAUDE.md requires a test for:
 *
 *  - **Only the owner may edit or restore.** A manager at the sale's own shop
 *    is refused, not merely hidden from the button. Both functions, because a
 *    permission proven on one says nothing about the other (D-34).
 *  - **`businessDate` is DERIVED from `occurredAt`, never sent.** This is the
 *    whole risk the owner accepted when they allowed date edits: the figure
 *    moves between reporting days, and it must land on the day the global
 *    04:00 cutoff says it does (§4.2, D-18) — including the case just before
 *    the cutoff, which belongs to the previous day.
 *  - **The amount survives as an exact string** (§4.1, D-13), and an edit that
 *    touches only the date does not silently re-price the sale.
 *  - **A moved sale drops a preset it can no longer point at**, so one
 *    branch's price list never appears in another's (D-15).
 *  - **Staff attribution is validated against the target shop**, or Sales by
 *    Staff (§9) gains rows nobody can explain.
 *  - **Un-void restores revenue and keeps the void in the audit trail** — the
 *    VOID row must still be there next to the UNVOID row.
 *  - **A voided sale cannot be edited**, and HQ cannot receive a sale (§4.12).
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, makeShop, uniq, makeActorWithUser } from "./helpers";
import { createSale, updateSale, unvoidSale, voidSale } from "../sales";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

const shopIds: string[] = [];
const userIds: string[] = [];
const customerIds: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.sale.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.salePreset.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  await prisma.workSession.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });

  customerIds.length = 0;
  userIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const db = prisma as unknown as Prisma.TransactionClient;

async function makeSaleShop(name = "Sale Edit") {
  const shop = await makeShop(prisma, name);
  shopIds.push(shop.id);
  return shop;
}

async function makeUser(
  role: "OWNER" | "MANAGER" | "STAFF",
  atShops: string[] = []
): Promise<Actor> {
  const actor = await makeActorWithUser(db, {
    role,
    shopIds: atShops,
    defaultShopId: atShops[0] ?? null,
    businessDate: new Date("2026-09-21T00:00:00.000Z"),
  });
  userIds.push(actor.userId);
  return actor;
}

async function makePreset(shopId: string, amount: number, label = `${amount}`) {
  return prisma.salePreset.create({
    data: { shopId, label, amount: new Prisma.Decimal(amount), sortOrder: 0 },
  });
}

async function makeCustomer(name = `Cust ${uniq()}`) {
  const c = await prisma.customer.create({
    data: (() => {
      const phone = `62812${Math.floor(Math.random() * 1e8)
        .toString()
        .padStart(8, "0")}`;
      return { name, phoneRaw: phone, phoneNormalized: phone };
    })(),
  });
  customerIds.push(c.id);
  return c;
}

/**
 * An actor with a work session at `shop`, which `createSale` requires. The
 * work session carries the shop object itself, so the fixture must attach a
 * real one rather than only an id.
 */
async function working(actor: Actor, shop: { id: string }) {
  const full = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
  await prisma.workSession.create({
    data: {
      userId: actor.userId,
      shopId: shop.id,
      businessDate: actor.businessDate,
    },
  });
  return {
    ...actor,
    workSession: { shopId: shop.id, shop: full },
  } as Actor & { workSession: NonNullable<Actor["workSession"]> };
}

/** Record a sale the way the till does, so the row under test is a real one. */
async function recordSale(
  actor: Actor,
  shop: { id: string },
  input: Parameters<typeof createSale>[1]
) {
  const w = await working(actor, shop);
  return prisma.$transaction((tx) => createSale(w, input, tx));
}

// ──────────────────────────── permission ────────────────────────────

describe("who may edit a sale (§3.4, D-181)", () => {
  it("refuses a MANAGER at the sale's own shop", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const manager = await makeUser("MANAGER", [shop.id]);
    const sale = await recordSale(manager, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const error = await updateSale(manager, sale.id, {
      paymentMethod: "EDC",
      reason: "manager should not be able to do this",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("FORBIDDEN");

    // And nothing moved.
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.paymentMethod).toBe("CASH");
  });

  it("refuses a STAFF member their own sale", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const error = await updateSale(staff, sale.id, {
      amount: 10_000,
      reason: "staff should not be able to do this",
    }).catch((e) => e);

    expect((error as AppError).code).toBe("FORBIDDEN");
  });

  it("refuses a MANAGER the un-void (a separate branch from the edit)", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const manager = await makeUser("MANAGER", [shop.id]);
    const sale = await recordSale(manager, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });
    await voidSale(manager, sale.id, { reason: "voided in error" });

    const error = await unvoidSale(manager, sale.id, {
      reason: "manager should not be able to restore",
    }).catch((e) => e);

    expect((error as AppError).code).toBe("FORBIDDEN");
    const after = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(after.status).toBe("VOIDED");
  });
});

// ───────────────────────── date and business date ─────────────────────────

describe("editing when a sale happened (§4.2, D-18)", () => {
  it("derives businessDate from the new occurredAt, moving the sale between reporting days", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    // 14:00 Jakarta on 18 Sep = 07:00 UTC. Comfortably after the 04:00 cutoff,
    // so it belongs to 18 Sep.
    const updated = await updateSale(owner, sale.id, {
      occurredAt: "2026-09-18T07:00:00.000Z",
      reason: "keyed in on the wrong day",
    });

    expect(updated.businessDate).toBe("2026-09-18");

    const row = await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } });
    expect(row.businessDate.toISOString().slice(0, 10)).toBe("2026-09-18");
  });

  it("files a time before the 04:00 cutoff against the PREVIOUS business day", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    // 02:30 Jakarta on 19 Sep = 19:30 UTC on 18 Sep. Before the cutoff, so it
    // is still the 18th's business day — the late-night session rule (§4.2).
    const updated = await updateSale(owner, sale.id, {
      occurredAt: "2026-09-18T19:30:00.000Z",
      reason: "late night session, wrong day",
    });

    expect(updated.businessDate).toBe("2026-09-18");
  });

  it("resolves the instant in the SHOP's timezone, not in UTC", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    // 22:00 UTC on 18 Sep is 05:00 JAKARTA on 19 Sep — past the 04:00 cutoff,
    // so the business day is the 19th. Truncating the UTC timestamp instead
    // would say the 18th, which is the bug this case exists to catch: it puts
    // an evening sale on the wrong day's report for every branch east of UTC.
    const updated = await updateSale(owner, sale.id, {
      occurredAt: "2026-09-18T22:00:00.000Z",
      reason: "timezone must be the shop's, not the server's",
    });

    expect(updated.businessDate).toBe("2026-09-19");
  });

  it("refuses a sale dated in the future", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const error = await updateSale(owner, sale.id, {
      occurredAt: tomorrow,
      reason: "should be refused",
    }).catch((e) => e);

    expect((error as AppError).code).toBe("VALIDATION_FAILED");
  });
});

// ─────────────────────────────── money ───────────────────────────────

describe("editing the amount (§4.1, D-13)", () => {
  it("keeps the amount exactly when only the date is edited", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 75_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const updated = await updateSale(owner, sale.id, {
      occurredAt: "2026-09-18T07:00:00.000Z",
      reason: "wrong day only",
    });

    expect(updated.amount).toBe(sale.amount);
    expect(updated.preset?.id).toBe(preset.id);
    expect(updated.isCustomAmount).toBe(false);
  });

  it("switches a preset sale to a custom amount, as an exact string", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const updated = await updateSale(owner, sale.id, {
      amount: 65_000,
      reason: "customer paid more than was rung up",
    });

    expect(updated.amount).toBe("65000");
    expect(updated.isCustomAmount).toBe(true);
    expect(updated.preset).toBeNull();
    expect(typeof updated.amount).toBe("string");
  });

  it("reads a preset's amount from the database, not from the client", async () => {
    const shop = await makeSaleShop();
    const cheap = await makePreset(shop.id, 20_000, "20k");
    const dear = await makePreset(shop.id, 200_000, "200k");
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: cheap.id,
      paymentMethod: "CASH",
    });

    // Send the dear preset AND a contradicting amount would be refused by the
    // schema; sending the preset alone must take the database's figure.
    const updated = await updateSale(owner, sale.id, {
      presetId: dear.id,
      reason: "wrong price tapped",
    });

    expect(updated.amount).toBe("200000");
  });

  it("refuses a preset belonging to another shop (D-15)", async () => {
    const shopA = await makeSaleShop("Branch A");
    const shopB = await makeSaleShop("Branch B");
    const presetA = await makePreset(shopA.id, 50_000);
    const presetB = await makePreset(shopB.id, 999_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shopA.id]);
    const sale = await recordSale(staff, shopA, {
      presetId: presetA.id,
      paymentMethod: "CASH",
    });

    const error = await updateSale(owner, sale.id, {
      presetId: presetB.id,
      reason: "another branch's price list must not apply",
    }).catch((e) => e);

    expect((error as AppError).code).toBe("NOT_FOUND");
  });
});

// ─────────────────────────────── moving ───────────────────────────────

describe("moving a sale to another shop", () => {
  it("moves the revenue and drops a preset the new shop does not have", async () => {
    const shopA = await makeSaleShop("Branch A");
    const shopB = await makeSaleShop("Branch B");
    const presetA = await makePreset(shopA.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shopA.id, shopB.id]);
    const sale = await recordSale(staff, shopA, {
      presetId: presetA.id,
      paymentMethod: "CASH",
    });

    const updated = await updateSale(owner, sale.id, {
      shopId: shopB.id,
      reason: "rung up at the wrong branch",
    });

    expect(updated.shopId).toBe(shopB.id);
    // The figure is the fact; the preset was only how it was entered.
    expect(updated.amount).toBe("50000");
    expect(updated.preset).toBeNull();
  });

  it("refuses a move onto HQ (§4.12)", async () => {
    const shop = await makeSaleShop();
    const hq = await makeSaleShop("HQ");
    await prisma.shop.update({
      where: { id: hq.id },
      data: { isHqPseudoShop: true },
    });
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const error = await updateSale(owner, sale.id, {
      shopId: hq.id,
      reason: "HQ takes no sales",
    }).catch((e) => e);

    expect((error as AppError).code).toBe("VALIDATION_FAILED");
  });
});

// ─────────────────────────── staff attribution ───────────────────────────

describe("re-attributing a sale to another staff member (§9)", () => {
  it("accepts someone who works at that shop", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const ani = await makeUser("STAFF", [shop.id]);
    const budi = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(ani, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const updated = await updateSale(owner, sale.id, {
      recordedById: budi.userId,
      reason: "Budi rang this one up on Ani's login",
    });

    expect(updated.recordedBy.id).toBe(budi.userId);
  });

  it("refuses someone who does not work at that shop", async () => {
    const shopA = await makeSaleShop("Branch A");
    const shopB = await makeSaleShop("Branch B");
    const preset = await makePreset(shopA.id, 50_000);
    const owner = await makeUser("OWNER");
    const ani = await makeUser("STAFF", [shopA.id]);
    const elsewhere = await makeUser("STAFF", [shopB.id]);
    const sale = await recordSale(ani, shopA, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const error = await updateSale(owner, sale.id, {
      recordedById: elsewhere.userId,
      reason: "should be refused",
    }).catch((e) => e);

    expect((error as AppError).code).toBe("VALIDATION_FAILED");
  });

  it("accepts the OWNER, who holds no UserShop row anywhere (D-122)", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const ani = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(ani, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const updated = await updateSale(owner, sale.id, {
      recordedById: owner.userId,
      reason: "I rang this one up myself",
    });

    expect(updated.recordedBy.id).toBe(owner.userId);
  });
});

// ────────────────────────────── customer ──────────────────────────────

describe("changing the customer (D-12)", () => {
  it("attaches a customer to a walk-in sale and refreshes their last visit", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const customer = await makeCustomer();
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    expect(sale.customer).toBeNull();

    const updated = await updateSale(owner, sale.id, {
      customerId: customer.id,
      reason: "forgot to scan the member card",
    });

    expect(updated.customer?.id).toBe(customer.id);

    const row = await prisma.customer.findUniqueOrThrow({
      where: { id: customer.id },
    });
    expect(row.lastSeenAt?.toISOString()).toBe(updated.occurredAt);
  });

  it("clears a customer back to walk-in with an explicit null", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const customer = await makeCustomer();
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
      customerId: customer.id,
    });

    const updated = await updateSale(owner, sale.id, {
      customerId: null,
      reason: "wrong customer attached",
    });

    expect(updated.customer).toBeNull();
  });
});

// ────────────────────────────── un-void ──────────────────────────────

describe("restoring a voided sale (D-181)", () => {
  it("returns it to COMPLETED and keeps BOTH the void and the un-void in the audit trail", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    await voidSale(owner, sale.id, { reason: "voided by mistake" });
    const restored = await unvoidSale(owner, sale.id, {
      reason: "that void was the mistake",
    });

    expect(restored.status).toBe("COMPLETED");
    expect(restored.voidedAt).toBeNull();
    expect(restored.voidReason).toBeNull();

    const audit = await prisma.auditLog.findMany({
      where: { entity: "Sale", entityId: sale.id },
      orderBy: { occurredAt: "asc" },
      select: { action: true, reason: true },
    });
    const actions = audit.map((a) => a.action);
    expect(actions).toContain("VOID");
    expect(actions).toContain("UNVOID");
    // The void's own reason is not erased by the reversal.
    expect(audit.find((a) => a.action === "VOID")?.reason).toBe(
      "voided by mistake"
    );
  });

  it("refuses to restore a sale that was never voided", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    const error = await unvoidSale(owner, sale.id, {
      reason: "nothing to restore",
    }).catch((e) => e);

    expect((error as AppError).code).toBe("SALE_NOT_EDITABLE");
  });

  it("refuses to EDIT a voided sale — it must be restored first", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });
    await voidSale(owner, sale.id, { reason: "voided first" });

    const error = await updateSale(owner, sale.id, {
      amount: 10_000,
      reason: "should be refused",
    }).catch((e) => e);

    expect((error as AppError).code).toBe("SALE_NOT_EDITABLE");
  });
});

// ─────────────────────────────── audit ───────────────────────────────

describe("the audit row an edit writes (§4.16)", () => {
  it("records the reason and a full before/after snapshot", async () => {
    const shop = await makeSaleShop();
    const preset = await makePreset(shop.id, 50_000);
    const owner = await makeUser("OWNER");
    const staff = await makeUser("STAFF", [shop.id]);
    const sale = await recordSale(staff, shop, {
      presetId: preset.id,
      paymentMethod: "CASH",
    });

    await updateSale(owner, sale.id, {
      amount: 65_000,
      paymentMethod: "EDC",
      occurredAt: "2026-09-18T07:00:00.000Z",
      reason: "corrected after counting the till",
    });

    const row = await prisma.auditLog.findFirstOrThrow({
      where: { entity: "Sale", entityId: sale.id, action: "UPDATE" },
    });

    expect(row.reason).toBe("corrected after counting the till");

    const before = row.before as Record<string, unknown>;
    const after = row.after as Record<string, unknown>;

    // Money as a string in the log too (D-13) — this is what gets read back
    // years later.
    expect(before.amount).toBe("50000");
    expect(after.amount).toBe("65000");
    expect(before.paymentMethod).toBe("CASH");
    expect(after.paymentMethod).toBe("EDC");
    expect(after.businessDate).toBe("2026-09-18");
  });
});
