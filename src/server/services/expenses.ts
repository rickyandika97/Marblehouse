/**
 * Expenses and expense categories (PRD §4.12, §7.6).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * The delete-if-unused rule is the acceptance criterion for this phase.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A category with zero expense rows deletes outright. One with rows can only
 * be ARCHIVED, and the refusal is a **409 `CATEGORY_IN_USE` carrying the usage
 * count** — never a silent archive. The count is what makes the refusal
 * actionable: "in use" tells the owner to go looking, "in use by 42 expenses"
 * tells them whether it is worth the trouble.
 *
 * Archiving hides a category from new entries and preserves it in history
 * (§4.12), which is why historical expense reads must never filter on
 * `isArchived` — last year's electricity bills stay attributed to Electricity
 * even after it is retired.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HQ is the one shop that takes expenses but no sales.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `Shop.isHqPseudoShop` marks the "HQ / unallocated" row the seed creates so
 * the owner can record non-branch costs (§4.12). Phase 5's transfer code
 * deliberately REFUSES HQ; expenses must do the opposite. Do not reach for a
 * sale-shop guard here — it would reject exactly the shop this feature exists
 * to serve.
 *
 * Money is `Decimal` and crosses the wire as a string (D-13). `businessDate`
 * is computed server-side (§4.2, D-18); the client never sends it.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { businessDateFor, formatBusinessDate } from "@/lib/business-date";
import { writeAudit } from "@/server/audit";
import { type Actor, assignedShopIds, roleAtShop } from "@/server/auth/context";
import { assertShopAccess } from "@/server/auth/guards";
import { AppError, forbidden, notFound } from "@/server/errors";
import { getBusinessDayStartHour } from "@/server/services/settings";

/** §5.5 NF-4: every list screen paginates. */
const PAGE_SIZE = 50;

/**
 * Parse a money string to Decimal, refusing anything not strictly positive.
 *
 * The Zod schema already rejects these, so this looks redundant — it is not.
 * `createExpense` accepts an already-parsed input type, which means any caller
 * that does not go through the route (a job, a script, a future service, a
 * test) bypasses the schema entirely. Every other money path in this codebase
 * re-checks its own invariant at the point of the write for exactly that
 * reason (D-20, D-32), and this one is no different: a zero or negative
 * expense would quietly distort every §9 total that sums it.
 *
 * Caught by a test that called the service directly and got a zero-amount row.
 */
function toPositiveAmount(value: string): Prisma.Decimal {
  let amount: Prisma.Decimal;
  try {
    amount = new Prisma.Decimal(value);
  } catch {
    throw new AppError("VALIDATION_FAILED", "That is not a valid amount.");
  }
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The amount must be more than zero.",
    );
  }
  return amount;
}

// ───────────────────────────── schemas ─────────────────────────────

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isArchived: z.boolean().optional(),
});

/**
 * Amount arrives as a STRING and is parsed to Decimal here.
 *
 * A JSON number would already have been through a double by the time it
 * reached us, which §4.1 forbids for money. Accepting a string means the
 * value the client typed is the value we store.
 */
export const createExpenseSchema = z.object({
  shopId: z.string().min(1),
  categoryId: z.string().min(1),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 250000 or 250000.50")
    .refine((v) => Number(v) > 0, "The amount must be more than zero."),
  note: z.string().trim().max(500).optional(),
  /** Relative path from `storeReceipt`; the client never invents one. */
  receiptPath: z.string().trim().max(300).optional(),
  /**
   * D-124: a deliberate, narrow exception to "the client never sends
   * businessDate" (§4.2, CLAUDE.md rule 6). It backdates a receipt entered
   * late — it does not let the client pick an arbitrary reporting day.
   * `createExpense` still computes today's business date itself and refuses
   * anything after it; this is only ever a ceiling, never a value it trusts
   * outright.
   */
  businessDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date like 2026-08-20")
    .optional(),
});

export const updateExpenseSchema = z.object({
  categoryId: z.string().min(1).optional(),
  amount: z
    .string()
    .trim()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "Enter an amount like 250000 or 250000.50")
    .refine((v) => Number(v) > 0, "The amount must be more than zero.")
    .optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

export const listExpensesSchema = z.object({
  shopId: z.string().min(1).optional(),
  categoryId: z.string().min(1).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  cursor: z.string().min(1).optional(),
});

// ───────────────────────────── DTOs ─────────────────────────────

export interface ExpenseCategoryDTO {
  id: string;
  name: string;
  isArchived: boolean;
  sortOrder: number;
}

export interface ExpenseDTO {
  id: string;
  /** String, never a number — see D-13. */
  amount: string;
  note: string | null;
  hasReceipt: boolean;
  businessDate: string;
  createdAt: string;
  shop: { id: string; name: string; code: string };
  category: { id: string; name: string };
  recordedBy: { id: string; displayName: string };
}

function toCategoryDTO(row: {
  id: string;
  name: string;
  isArchived: boolean;
  sortOrder: number;
}): ExpenseCategoryDTO {
  return {
    id: row.id,
    name: row.name,
    isArchived: row.isArchived,
    sortOrder: row.sortOrder,
  };
}

type ExpenseRow = Prisma.ExpenseGetPayload<{
  include: {
    shop: { select: { id: true; name: true; code: true } };
    category: { select: { id: true; name: true } };
    user: { select: { id: true; displayName: true } };
  };
}>;

function toExpenseDTO(row: ExpenseRow): ExpenseDTO {
  return {
    id: row.id,
    amount: row.amount.toString(),
    note: row.note,
    // The path itself never leaves the server — it would be a map of the
    // data directory. The UI asks the authenticated route for the image.
    hasReceipt: row.receiptPath !== null,
    businessDate: formatBusinessDate(row.businessDate),
    createdAt: row.createdAt.toISOString(),
    shop: row.shop,
    category: row.category,
    recordedBy: row.user,
  };
}

// ───────────────────────────── categories ─────────────────────────────

/**
 * List categories. Non-archived by default (§7.6).
 *
 * `includeArchived` exists for the owner's category manager, which has to show
 * an archived row in order to offer un-archiving it.
 */
export async function listCategories(
  actor: Actor,
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<ExpenseCategoryDTO[]> {
  const isManagerSomewhere = [...actor.shopRoles.values()].some(
    (sr) => sr.role === "MANAGER"
  );
  if (!actor.isOwner && !isManagerSomewhere) {
    throw forbidden("Only managers and the owner can see expense categories.");
  }

  const rows = await prisma.expenseCategory.findMany({
    where: includeArchived ? {} : { isArchived: false },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(toCategoryDTO);
}

/** Create a category. OWNER only (§3.4). */
export async function createCategory(
  actor: Actor,
  input: z.infer<typeof categorySchema>,
): Promise<ExpenseCategoryDTO> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can manage expense categories.");
  }

  const existing = await prisma.expenseCategory.findUnique({
    where: { name: input.name },
  });
  if (existing) {
    throw new AppError(
      "CONFLICT",
      `There is already a category called "${input.name}".`,
    );
  }

  const created = await prisma.expenseCategory.create({
    data: { name: input.name, sortOrder: input.sortOrder ?? 0 },
  });

  await writeAudit(actor, {
    entity: "ExpenseCategory",
    entityId: created.id,
    action: "CREATE",
    after: { name: created.name, sortOrder: created.sortOrder },
  });

  return toCategoryDTO(created);
}

/** Rename, reorder, archive or un-archive. OWNER only. */
export async function updateCategory(
  actor: Actor,
  id: string,
  input: z.infer<typeof updateCategorySchema>,
): Promise<ExpenseCategoryDTO> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can manage expense categories.");
  }

  const before = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!before) throw notFound("That expense category no longer exists.");

  if (input.name && input.name !== before.name) {
    const clash = await prisma.expenseCategory.findUnique({
      where: { name: input.name },
    });
    if (clash) {
      throw new AppError(
        "CONFLICT",
        `There is already a category called "${input.name}".`,
      );
    }
  }

  const updated = await prisma.expenseCategory.update({
    where: { id },
    data: {
      name: input.name,
      sortOrder: input.sortOrder,
      isArchived: input.isArchived,
    },
  });

  await writeAudit(actor, {
    entity: "ExpenseCategory",
    entityId: id,
    action: "UPDATE",
    before: {
      name: before.name,
      sortOrder: before.sortOrder,
      isArchived: before.isArchived,
    },
    after: {
      name: updated.name,
      sortOrder: updated.sortOrder,
      isArchived: updated.isArchived,
    },
  });

  return toCategoryDTO(updated);
}

/**
 * Delete a category — **only if nothing references it** (§4.12, §7.6).
 *
 * This is Phase 7's acceptance criterion, so the shape matters:
 *
 *   - zero expense rows  → hard delete (one of the few permitted by §6.1.5)
 *   - one or more rows   → **409 CATEGORY_IN_USE, with the count in details**
 *
 * The refusal must never silently archive instead. An owner who asked to
 * delete and got a quiet archive would believe the category is gone while it
 * still sits in every historical report — and would have no idea why. Telling
 * them the count lets them decide whether to archive it themselves.
 *
 * The count includes SOFT-DELETED expenses on purpose. An `isDeleted` row is
 * still a row holding this `categoryId`, and hard-deleting the category would
 * break the foreign key it depends on. "Unused" has to mean structurally
 * unreferenced, not merely invisible.
 */
export async function deleteCategory(
  actor: Actor,
  id: string,
): Promise<{ deleted: true }> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can manage expense categories.");
  }

  const category = await prisma.expenseCategory.findUnique({ where: { id } });
  if (!category) throw notFound("That expense category no longer exists.");

  const usageCount = await prisma.expense.count({ where: { categoryId: id } });

  if (usageCount > 0) {
    throw new AppError(
      "CATEGORY_IN_USE",
      `"${category.name}" is used by ${usageCount} ${
        usageCount === 1 ? "expense" : "expenses"
      } and cannot be deleted. Archive it instead to hide it from new entries.`,
      { usageCount, categoryId: id, categoryName: category.name },
    );
  }

  await prisma.expenseCategory.delete({ where: { id } });

  await writeAudit(actor, {
    entity: "ExpenseCategory",
    entityId: id,
    action: "DELETE",
    before: { name: category.name, sortOrder: category.sortOrder },
  });

  return { deleted: true };
}

// ───────────────────────────── expenses ─────────────────────────────

/**
 * Which shops may this actor record an expense against?
 *
 * OWNER: any active shop, **including HQ**. MANAGER: their assignments only.
 * STAFF: none — §3.4 gives them no expense capability at all.
 */
async function assertCanRecordAgainst(
  actor: Actor,
  shopId: string,
): Promise<void> {
  // Role is per-shop (D-122): HQ has no shop assignment, so an OWNER-only
  // exemption below covers it; everywhere else, "may record here" means
  // MANAGER at this specific shop, not any bare non-STAFF check.
  if (!actor.isOwner && actor.shopRoles.get(shopId)?.role !== "MANAGER") {
    throw forbidden("Only managers and the owner can record expenses.");
  }

  const shop = await prisma.shop.findUnique({
    where: { id: shopId },
    select: { id: true, isActive: true, isHqPseudoShop: true },
  });
  if (!shop) throw notFound("That shop no longer exists.");
  if (!shop.isActive) {
    throw new AppError(
      "VALIDATION_FAILED",
      "That branch is deactivated and cannot take new expenses.",
    );
  }

  // NOTE: no `isHqPseudoShop` check. HQ deliberately ACCEPTS expenses — it is
  // the shop the owner records non-branch costs against (§4.12). Phase 5's
  // transfers refuse HQ; this must not copy that guard.
  assertShopAccess(actor, shopId);
}

/**
 * Record an expense (§7.6).
 *
 * `businessDate` defaults to the shop's timezone and the GLOBAL day-start hour
 * (§4.2, D-18), same as every other dated row. **D-124 is the one deliberate
 * exception to "the client never sends it":** a manager entering a receipt the
 * morning after can supply `businessDate` to backdate the expense, so it lands
 * in the report it actually belongs to instead of today's.
 *
 * This is a ceiling, not a delegation. The server still computes today's
 * business date itself and REJECTS anything after it — a client cannot record
 * an expense against tomorrow no matter what it sends. There is deliberately
 * no lower bound: an owner reconciling a stack of receipts from last quarter
 * is exactly who this exists for.
 */
export async function createExpense(
  actor: Actor,
  input: z.infer<typeof createExpenseSchema>,
  tx: Prisma.TransactionClient = prisma,
): Promise<ExpenseDTO> {
  await assertCanRecordAgainst(actor, input.shopId);

  const category = await tx.expenseCategory.findUnique({
    where: { id: input.categoryId },
    select: { id: true, name: true, isArchived: true },
  });
  if (!category) throw notFound("That expense category no longer exists.");
  if (category.isArchived) {
    // Archived means "hidden from NEW entries" (§4.12). History keeps it.
    throw new AppError(
      "VALIDATION_FAILED",
      `"${category.name}" has been archived and cannot take new expenses.`,
    );
  }

  const shop = await tx.shop.findUniqueOrThrow({
    where: { id: input.shopId },
    select: { timezone: true },
  });

  const today = businessDateFor(
    new Date(),
    shop.timezone,
    await getBusinessDayStartHour(),
  );

  let businessDate = today;
  if (input.businessDate) {
    // Parsed the same way `listExpenses` parses a filter date — UTC midnight,
    // matching the column type. Comparing as Dates rather than strings keeps
    // this correct regardless of format.
    businessDate = new Date(`${input.businessDate}T00:00:00Z`);
    if (businessDate.getTime() > today.getTime()) {
      throw new AppError(
        "VALIDATION_FAILED",
        "An expense cannot be dated in the future.",
      );
    }
  }

  const created = await tx.expense.create({
    data: {
      shopId: input.shopId,
      categoryId: input.categoryId,
      userId: actor.userId,
      amount: toPositiveAmount(input.amount),
      note: input.note ?? null,
      receiptPath: input.receiptPath ?? null,
      businessDate,
    },
    include: {
      shop: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
      user: { select: { id: true, displayName: true } },
    },
  });

  return toExpenseDTO(created);
}

/**
 * List expenses, scoped by role in SQL (§5.6: never filter in JavaScript).
 *
 * A MANAGER sees their assigned shops; §3.4 says they view reports one shop at
 * a time, which the UI enforces by always passing `shopId`. The service still
 * narrows to their assignments so a missing parameter cannot widen the result.
 */
export async function listExpenses(
  actor: Actor,
  input: z.infer<typeof listExpensesSchema>,
): Promise<{ expenses: ExpenseDTO[]; total: string; nextCursor: string | null }> {
  const canViewHere = input.shopId
    ? actor.isOwner || actor.shopRoles.get(input.shopId)?.role === "MANAGER"
    : actor.isOwner ||
      [...actor.shopRoles.values()].some((sr) => sr.role === "MANAGER");
  if (!canViewHere) {
    throw forbidden("Only managers and the owner can view expenses.");
  }

  if (input.shopId) assertShopAccess(actor, input.shopId);

  const shopFilter: Prisma.ExpenseWhereInput = input.shopId
    ? { shopId: input.shopId }
    : actor.isOwner
      ? {}
      : { shopId: { in: assignedShopIds(actor) } };

  const where: Prisma.ExpenseWhereInput = {
    ...shopFilter,
    isDeleted: false,
    ...(input.categoryId ? { categoryId: input.categoryId } : {}),
    ...(input.from || input.to
      ? {
          businessDate: {
            ...(input.from ? { gte: new Date(`${input.from}T00:00:00Z`) } : {}),
            ...(input.to ? { lte: new Date(`${input.to}T00:00:00Z`) } : {}),
          },
        }
      : {}),
  };

  const rows = await prisma.expense.findMany({
    where,
    include: {
      shop: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
      user: { select: { id: true, displayName: true } },
    },
    orderBy: [{ businessDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, PAGE_SIZE);
  const nextCursor =
    rows.length > PAGE_SIZE ? (page[page.length - 1]?.id ?? null) : null;

  // The running total covers the whole filtered range, not just this page —
  // a total that only added up 50 of 200 rows would be quietly wrong (§8.8).
  const sum = await prisma.expense.aggregate({ where, _sum: { amount: true } });

  return {
    expenses: page.map(toExpenseDTO),
    total: (sum._sum.amount ?? new Prisma.Decimal(0)).toString(),
    nextCursor,
  };
}

/** One expense, subject to the same shop scoping as the list. */
export async function getExpense(
  actor: Actor,
  id: string,
): Promise<ExpenseDTO> {
  const row = await prisma.expense.findFirst({
    where: { id, isDeleted: false },
    include: {
      shop: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
      user: { select: { id: true, displayName: true } },
    },
  });
  if (!row) throw notFound("That expense no longer exists.");

  if (!actor.isOwner && roleAtShop(actor, row.shopId) !== "MANAGER") {
    throw forbidden("Only managers and the owner can view expenses.");
  }
  return toExpenseDTO(row);
}

/**
 * The receipt path for one expense, re-checking access (§4.15's rule applied
 * to receipts: no static serving of `data/`).
 *
 * Returns the RELATIVE path; the caller resolves it through
 * `resolveReceiptPath`. Deliberately mirrors `getAttendancePhotoPath` so both
 * image routes have the same shape and the same guarantee.
 */
export async function getReceiptPath(
  actor: Actor,
  expenseId: string,
): Promise<string> {
  const row = await prisma.expense.findFirst({
    where: { id: expenseId, isDeleted: false },
    select: { shopId: true, receiptPath: true },
  });
  if (!row) throw notFound("That expense no longer exists.");

  if (!actor.isOwner && roleAtShop(actor, row.shopId) !== "MANAGER") {
    throw forbidden("Only managers and the owner can view receipts.");
  }

  if (!row.receiptPath) throw notFound("That expense has no receipt.");
  return row.receiptPath;
}

/** Attach a stored receipt to an expense the actor may reach. */
export async function attachReceipt(
  actor: Actor,
  expenseId: string,
  relativePath: string,
): Promise<ExpenseDTO> {
  const existing = await prisma.expense.findFirst({
    where: { id: expenseId, isDeleted: false },
    select: { id: true, shopId: true },
  });
  if (!existing) throw notFound("That expense no longer exists.");

  if (!actor.isOwner && roleAtShop(actor, existing.shopId) !== "MANAGER") {
    throw forbidden("Only managers and the owner can record expenses.");
  }

  const updated = await prisma.expense.update({
    where: { id: expenseId },
    data: { receiptPath: relativePath },
    include: {
      shop: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
      user: { select: { id: true, displayName: true } },
    },
  });

  return toExpenseDTO(updated);
}

/** Edit an expense. OWNER only (§7.6), audit-logged with before/after. */
export async function updateExpense(
  actor: Actor,
  id: string,
  input: z.infer<typeof updateExpenseSchema>,
): Promise<ExpenseDTO> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can edit an expense.");
  }

  const before = await prisma.expense.findFirst({
    where: { id, isDeleted: false },
  });
  if (!before) throw notFound("That expense no longer exists.");

  if (input.categoryId && input.categoryId !== before.categoryId) {
    const category = await prisma.expenseCategory.findUnique({
      where: { id: input.categoryId },
      select: { id: true, name: true, isArchived: true },
    });
    if (!category) throw notFound("That expense category no longer exists.");
    if (category.isArchived) {
      throw new AppError(
        "VALIDATION_FAILED",
        `"${category.name}" has been archived and cannot take new expenses.`,
      );
    }
  }

  const updated = await prisma.expense.update({
    where: { id },
    data: {
      categoryId: input.categoryId,
      ...(input.amount !== undefined
        ? { amount: toPositiveAmount(input.amount) }
        : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    },
    include: {
      shop: { select: { id: true, name: true, code: true } },
      category: { select: { id: true, name: true } },
      user: { select: { id: true, displayName: true } },
    },
  });

  await writeAudit(actor, {
    shopId: before.shopId,
    entity: "Expense",
    entityId: id,
    action: "UPDATE",
    before: {
      categoryId: before.categoryId,
      amount: before.amount.toString(),
      note: before.note,
    },
    after: {
      categoryId: updated.categoryId,
      amount: updated.amount.toString(),
      note: updated.note,
    },
  });

  return toExpenseDTO(updated);
}

/**
 * Soft-delete an expense (§6.1.5 — anything touching money is soft-deleted).
 *
 * The row stays, `isDeleted` flips, and §4.16 requires the audit entry. A hard
 * delete would remove the only evidence that the money was ever recorded.
 */
export async function deleteExpense(
  actor: Actor,
  id: string,
  reason: string,
): Promise<{ deleted: true }> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can delete an expense.");
  }

  const before = await prisma.expense.findFirst({
    where: { id, isDeleted: false },
  });
  if (!before) throw notFound("That expense no longer exists.");

  await prisma.expense.update({
    where: { id },
    data: { isDeleted: true },
  });

  await writeAudit(actor, {
    shopId: before.shopId,
    entity: "Expense",
    entityId: id,
    action: "DELETE",
    reason,
    before: {
      categoryId: before.categoryId,
      amount: before.amount.toString(),
      note: before.note,
    },
  });

  return { deleted: true };
}
