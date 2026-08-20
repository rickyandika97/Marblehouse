/**
 * Expenses and expense categories (PRD §4.12, §7.6, §16 Phase 7).
 *
 * These write real rows and clean up in `afterEach`, following
 * `attendance.test.ts` — the service opens its own transactions, so it cannot
 * run inside `withRollback`'s.
 *
 * What is worth proving here rather than assuming:
 *
 *  - **The delete-if-unused rule**, which is Phase 7's acceptance criterion
 *    (§16). Both branches: zero rows deletes, one row refuses with 409
 *    `CATEGORY_IN_USE` **and the usage count**. A refusal without the count is
 *    not the specified behaviour.
 *  - **HQ accepts expenses.** Phase 5's transfers refuse `isHqPseudoShop`;
 *    expenses must do the opposite (§4.12), and nothing else in the codebase
 *    tests that difference.
 *  - **Money survives the round trip as a string** (§4.1, D-13) — no float
 *    artefact, and two decimal places preserved.
 *  - **`businessDate` is server-computed by default** (§4.2, D-18), and a
 *    client-sent one is honoured only up to today — D-124's future-date
 *    ceiling, never a delegation of the value itself.
 *  - **Role scoping**, including a manager reaching another branch by ID.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma, makeShop, uniq, makeActorWithUser } from "./helpers";
import {
  createCategory,
  createExpense,
  createExpenseSchema,
  deleteCategory,
  deleteExpense,
  listCategories,
  listExpenses,
  updateCategory,
  updateExpense,
} from "../expenses";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

const shopIds: string[] = [];
const userIds: string[] = [];
const categoryIds: string[] = [];

afterEach(async () => {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { entityId: { in: categoryIds } },
        { userId: { in: userIds } },
      ],
    },
  });
  await prisma.expense.deleteMany({ where: { shopId: { in: shopIds } } });
  await prisma.expenseCategory.deleteMany({ where: { id: { in: categoryIds } } });
  await prisma.userShop.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.shop.deleteMany({ where: { id: { in: shopIds } } });

  categoryIds.length = 0;
  userIds.length = 0;
  shopIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function makeUser(
  role: "OWNER" | "MANAGER" | "STAFF",
  shopIds: string[],
): Promise<Actor> {
  const actor = await makeActorWithUser(prisma as unknown as Prisma.TransactionClient, {
    role,
    shopIds,
    defaultShopId: shopIds[0] ?? null,
    businessDate: new Date("2026-08-07T00:00:00.000Z"),
  });
  userIds.push(actor.userId);
  return actor;
}

async function makeCategory(name = `Cat ${uniq()}`) {
  const row = await prisma.expenseCategory.create({ data: { name } });
  categoryIds.push(row.id);
  return row;
}

// ─────────────────────── the acceptance criterion ───────────────────────

describe("deleting a category (§16 acceptance criterion)", () => {
  it("deletes outright when nothing references it", async () => {
    const owner = await makeUser("OWNER", []);
    const category = await makeCategory();

    await expect(deleteCategory(owner, category.id)).resolves.toEqual({
      deleted: true,
    });

    const after = await prisma.expenseCategory.findUnique({
      where: { id: category.id },
    });
    expect(after).toBeNull();
  });

  it("refuses with CATEGORY_IN_USE and the usage count when it has rows", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    for (const amount of ["1000", "2000", "3000"]) {
      await createExpense(owner, {
        shopId: shop.id,
        categoryId: category.id,
        amount,
      });
    }

    const error = await deleteCategory(owner, category.id).catch((e) => e);

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("CATEGORY_IN_USE");
    expect(error.status).toBe(409);
    // The COUNT is the point — it is what makes the refusal actionable.
    expect(error.details.usageCount).toBe(3);
    expect(error.message).toContain("3 expenses");

    // And it must NOT have silently archived instead.
    const still = await prisma.expenseCategory.findUnique({
      where: { id: category.id },
    });
    expect(still).not.toBeNull();
    expect(still?.isArchived).toBe(false);
  });

  it("still refuses when the only expense is soft-deleted", async () => {
    // "Unused" must mean structurally unreferenced, not merely invisible — a
    // soft-deleted row still holds the foreign key.
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    const expense = await createExpense(owner, {
      shopId: shop.id,
      categoryId: category.id,
      amount: "5000",
    });
    await deleteExpense(owner, expense.id, "keyed in twice");

    const error = await deleteCategory(owner, category.id).catch((e) => e);
    expect(error.code).toBe("CATEGORY_IN_USE");
    expect(error.details.usageCount).toBe(1);
    expect(error.message).toContain("1 expense");
  });

  it("archiving hides it from new entries but keeps history", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    await createExpense(owner, {
      shopId: shop.id,
      categoryId: category.id,
      amount: "7500",
    });

    await updateCategory(owner, category.id, { isArchived: true });

    // Gone from the picker...
    const active = await listCategories(owner);
    expect(active.map((c) => c.id)).not.toContain(category.id);

    // ...but still visible to the manager screen that offers un-archiving...
    const all = await listCategories(owner, { includeArchived: true });
    expect(all.map((c) => c.id)).toContain(category.id);

    // ...and history still names it (§4.12).
    const { expenses } = await listExpenses(owner, { shopId: shop.id });
    expect(expenses[0]?.category.id).toBe(category.id);

    // A new expense against it is refused.
    await expect(
      createExpense(owner, {
        shopId: shop.id,
        categoryId: category.id,
        amount: "100",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("refuses a plain manager, not just a staff member", async () => {
    const category = await makeCategory();
    const manager = await makeUser("MANAGER", []);

    await expect(deleteCategory(manager, category.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

// ─────────────────────────── HQ (§4.12) ───────────────────────────

describe("the HQ pseudo-shop", () => {
  it("accepts an expense, unlike a transfer", async () => {
    // Phase 5 deliberately REFUSES isHqPseudoShop. Expenses must not copy
    // that guard — HQ exists precisely to hold non-branch costs.
    const id = uniq();
    const hq = await prisma.shop.create({
      data: {
        code: `HQ-${id}`,
        name: `HQ ${id}`,
        timezone: "Asia/Jakarta",
        isHqPseudoShop: true,
      },
    });
    shopIds.push(hq.id);

    const owner = await makeUser("OWNER", [hq.id]);
    const category = await makeCategory();

    const expense = await createExpense(owner, {
      shopId: hq.id,
      categoryId: category.id,
      amount: "1250000",
      note: "Head office internet",
    });

    expect(expense.shop.id).toBe(hq.id);
    expect(expense.amount).toBe("1250000");
  });
});

// ─────────────────────────── money (§4.1) ───────────────────────────

describe("money", () => {
  it("keeps two decimal places and never becomes a float", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    const expense = await createExpense(owner, {
      shopId: shop.id,
      categoryId: category.id,
      amount: "1234567890.12",
    });

    // A string out of the DTO (D-13), exact to the stored scale.
    expect(expense.amount).toBe("1234567890.12");
    expect(typeof expense.amount).toBe("string");

    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.amount).toBeInstanceOf(Prisma.Decimal);
    expect(row.amount.toString()).toBe("1234567890.12");
  });

  it("sums the whole filtered range, not just the returned page", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    for (const amount of ["10.50", "20.25", "30.25"]) {
      await createExpense(owner, {
        shopId: shop.id,
        categoryId: category.id,
        amount,
      });
    }

    const { total, expenses } = await listExpenses(owner, { shopId: shop.id });
    expect(expenses).toHaveLength(3);
    expect(total).toBe("61");
  });

  it("rejects a zero or negative amount", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    for (const amount of ["0", "0.00"]) {
      await expect(
        createExpense(owner, {
          shopId: shop.id,
          categoryId: category.id,
          amount,
        }),
      ).rejects.toBeTruthy();
    }
  });
});

// ────────────────────── businessDate (§4.2, D-18, D-124) ──────────────────────

describe("businessDate", () => {
  it("defaults to today when the client sends nothing", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    const input = createExpenseSchema.parse({
      shopId: shop.id,
      categoryId: category.id,
      amount: "1000",
    });

    const expense = await createExpense(owner, input);

    expect(expense.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("honours an explicit past date — D-124's whole reason to exist", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    const input = createExpenseSchema.parse({
      shopId: shop.id,
      categoryId: category.id,
      amount: "1000",
      businessDate: "1999-01-01",
    });

    const expense = await createExpense(owner, input);

    expect(expense.businessDate).toBe("1999-01-01");
  });

  it("refuses a future date — the client's date is a ceiling the server still enforces", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    const farFuture = "2999-01-01";
    const input = createExpenseSchema.parse({
      shopId: shop.id,
      categoryId: category.id,
      amount: "1000",
      businessDate: farFuture,
    });

    await expect(createExpense(owner, input)).rejects.toThrow(AppError);
  });
});

// ─────────────────────── role scoping (§3.4) ───────────────────────

describe("permissions", () => {
  it("refuses STAFF everywhere", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const staff = await makeUser("STAFF", [shop.id]);
    const category = await makeCategory();

    await expect(listCategories(staff)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(listExpenses(staff, {})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      createExpense(staff, {
        shopId: shop.id,
        categoryId: category.id,
        amount: "1000",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("stops a manager reaching a branch outside their assignments by ID", async () => {
    const mine = await makeShop(prisma, "Mine");
    const yours = await makeShop(prisma, "Yours");
    shopIds.push(mine.id, yours.id);

    const manager = await makeUser("MANAGER", [mine.id]);
    const category = await makeCategory();

    await expect(
      createExpense(manager, {
        shopId: yours.id,
        categoryId: category.id,
        amount: "1000",
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      listExpenses(manager, { shopId: yours.id }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("narrows an unscoped manager list to their own shops", async () => {
    // The absent-parameter branch — D-34's lesson: one branch passing says
    // nothing about the other.
    const mine = await makeShop(prisma, "Mine");
    const yours = await makeShop(prisma, "Yours");
    shopIds.push(mine.id, yours.id);

    const owner = await makeUser("OWNER", [mine.id, yours.id]);
    const manager = await makeUser("MANAGER", [mine.id]);
    const category = await makeCategory();

    await createExpense(owner, {
      shopId: mine.id,
      categoryId: category.id,
      amount: "111",
    });
    await createExpense(owner, {
      shopId: yours.id,
      categoryId: category.id,
      amount: "222",
    });

    const { expenses, total } = await listExpenses(manager, {});
    expect(expenses).toHaveLength(1);
    expect(expenses[0]?.shop.id).toBe(mine.id);
    // The total must respect the same scoping, or it leaks the other branch.
    expect(total).toBe("111");
  });

  it("hides a staff-only branch from a mixed-role manager's list (D-138)", async () => {
    // MANAGER at one branch, STAFF at another. Expenses are a manager view,
    // so the branch they only staff must not appear — not in the rows, and
    // not in the total, which is the half that leaks quietly.
    const managed = await makeShop(prisma, "Managed");
    const staffed = await makeShop(prisma, "Staffed");
    shopIds.push(managed.id, staffed.id);

    const owner = await makeUser("OWNER", [managed.id, staffed.id]);
    const budi = await makeUser("MANAGER", [managed.id]);
    // Assign the second shop as STAFF — the shape `makeUser` cannot build.
    await prisma.userShop.create({
      data: { userId: budi.userId, shopId: staffed.id, role: "STAFF" },
    });
    budi.shopRoles.set(staffed.id, { role: "STAFF", canEnterCost: false });

    const category = await makeCategory();
    await createExpense(owner, {
      shopId: managed.id,
      categoryId: category.id,
      amount: "111",
    });
    await createExpense(owner, {
      shopId: staffed.id,
      categoryId: category.id,
      amount: "222",
    });

    // Unscoped: only the managed branch.
    const { expenses, total } = await listExpenses(budi, {});
    expect(expenses).toHaveLength(1);
    expect(expenses[0]?.shop.id).toBe(managed.id);
    expect(total).toBe("111");

    // Explicitly asking for the staffed branch is refused outright.
    await expect(
      listExpenses(budi, { shopId: staffed.id })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("refuses a manager editing or deleting an expense", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const manager = await makeUser("MANAGER", [shop.id]);
    const category = await makeCategory();

    const expense = await createExpense(owner, {
      shopId: shop.id,
      categoryId: category.id,
      amount: "1000",
    });

    await expect(
      updateExpense(manager, expense.id, { amount: "9999" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      deleteExpense(manager, expense.id, "nope"),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ─────────────────── soft delete + audit (§4.16, §6.1.5) ───────────────────

describe("deleting an expense", () => {
  it("soft-deletes, keeps the row, and writes an audit entry with the reason", async () => {
    const shop = await makeShop(prisma, "Expense");
    shopIds.push(shop.id);
    const owner = await makeUser("OWNER", [shop.id]);
    const category = await makeCategory();

    const expense = await createExpense(owner, {
      shopId: shop.id,
      categoryId: category.id,
      amount: "4200",
    });

    await deleteExpense(owner, expense.id, "duplicate of the March invoice");

    const row = await prisma.expense.findUniqueOrThrow({
      where: { id: expense.id },
    });
    expect(row.isDeleted).toBe(true);
    expect(row.amount.toString()).toBe("4200");

    const audit = await prisma.auditLog.findFirst({
      where: { entity: "Expense", entityId: expense.id, action: "DELETE" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.reason).toBe("duplicate of the March invoice");

    // And it drops out of the list and its total.
    const { expenses, total } = await listExpenses(owner, { shopId: shop.id });
    expect(expenses).toHaveLength(0);
    expect(total).toBe("0");
  });
});
