/**
 * Sales (PRD §4.3, §7.2, §8.2).
 *
 * The two rules that shape this whole file:
 *
 *   1. A SALE RECORDS MONEY ONLY. There is no marbleCount on a sale or a
 *      preset, and there never will be (§4.3, decision 18.1). Marbles are
 *      physical; the app tracks cash in, and separately tracks marbles a
 *      customer chose to store (§4.5).
 *
 *   2. THE CLIENT CANNOT CHOOSE THE SHOP OR THE USER. Both come from the work
 *      session (§4.7) and the session cookie. `businessDate` is computed
 *      server-side on every row (§6.1.4). A client that sends any of them is
 *      ignored, not trusted.
 *
 * Sales are never edited. They are voided, which reverses them without deleting
 * anything (§4.3).
 */
import { z } from "zod";
import { Prisma, type Sale } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError, forbidden, notFound } from "@/server/errors";
import { writeAudit } from "@/server/audit";
import { businessDateFor } from "@/lib/business-date";
import { getBusinessDayStartHour } from "@/server/services/settings";
import { formatPhoneLocal } from "@/lib/phone";
import { hasShopAccess, type Actor } from "@/server/auth/context";
import { toSaleDTO, type SaleDTO } from "@/server/dto/sale";
import { refreshLastSeenAt } from "./customers";

/** NF-4: paginate every list. */
export const PAGE_SIZE = 50;

/** Rp 10.000.000 for one sale is a typo, not a transaction. */
const MAX_SALE_AMOUNT = 10_000_000;

/**
 * A sale is a preset OR a custom amount, never both and never neither.
 *
 * Modelled as a union so the invalid states cannot be constructed — a body with
 * both fields is rejected by the schema rather than by a runtime check we might
 * forget to write.
 */
export const createSaleSchema = z
  .object({
    presetId: z.string().min(1).optional(),
    amount: z.number().int().positive().max(MAX_SALE_AMOUNT).optional(),
    paymentMethod: z.enum(["CASH", "EDC"]),
    customerId: z.string().min(1).nullable().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((v) => (v.presetId === undefined) !== (v.amount === undefined), {
    message: "Choose a preset amount, or enter a custom amount — not both.",
    path: ["presetId"],
  });

export const voidSaleSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Say why this sale is being voided.")
    .max(500),
});

export const listSalesSchema = z.object({
  shopId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().optional(),
  customerId: z.string().optional(),
  paymentMethod: z.enum(["CASH", "EDC"]).optional(),
  cursor: z.string().optional(),
});

export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type VoidSaleInput = z.infer<typeof voidSaleSchema>;
export type ListSalesInput = z.infer<typeof listSalesSchema>;

/** The actor's work session, which every sale is attributed to. */
type WorkingActor = Actor & { workSession: NonNullable<Actor["workSession"]> };

const SALE_INCLUDE = {
  preset: true,
  customer: { select: { id: true, name: true, phoneNormalized: true } },
  recordedBy: { select: { id: true, displayName: true } },
} satisfies Prisma.SaleInclude;

const dto = (s: Prisma.SaleGetPayload<{ include: typeof SALE_INCLUDE }>) =>
  toSaleDTO(s, formatPhoneLocal);

// ─────────────────────────────── Presets ───────────────────────────────

export interface PresetDTO {
  id: string;
  label: string;
  amount: string;
  sortOrder: number;
}

/**
 * Active presets for the sale screen (§7.2 GET /api/shops/:id/presets).
 *
 * Presets are per-shop (§4.3). A deactivated preset stays in the database
 * because historical sales point at it — it simply stops being offered.
 */
export async function listPresets(shopId: string): Promise<PresetDTO[]> {
  const presets = await prisma.salePreset.findMany({
    where: { shopId, isActive: true },
    orderBy: [{ sortOrder: "asc" }, { amount: "asc" }],
  });

  return presets.map((p) => ({
    id: p.id,
    label: p.label,
    amount: p.amount.toString(),
    sortOrder: p.sortOrder,
  }));
}

// ─────────────────────────────── Record ───────────────────────────────

/**
 * Record a sale (§7.2 POST /api/sales).
 *
 * Runs inside the caller's transaction so that it commits atomically with the
 * idempotency key that protects it (NF-5) — see `runIdempotent`. Without that
 * shared transaction, a double-tap on shop wifi produces two sales, which is
 * the single most likely data-integrity failure in this product (R-3).
 */
export async function createSale(
  actor: WorkingActor,
  input: CreateSaleInput,
  tx: Prisma.TransactionClient
): Promise<SaleDTO> {
  const shop = actor.workSession.shop;

  // HQ is expense-only and accepts no sales (§4.12).
  if (shop.isHqPseudoShop) {
    throw forbidden("HQ does not record sales. Switch to a branch first.");
  }

  const { amount, presetId, isCustomAmount } = await resolveAmount(
    tx,
    shop.id,
    shop.allowCustomAmount,
    input
  );

  // The customer must exist and be usable before we attribute money to them.
  if (input.customerId) await assertCustomerUsable(tx, input.customerId);

  // Server-computed, never sent by the client (§6.1.4). The start hour is
  // GLOBAL (§4.2, D-18), so this row's date agrees with the actor's work
  // session and with every other branch's — which is what makes a combined
  // daily report mean one thing.
  const businessDate = businessDateFor(
    new Date(),
    shop.timezone,
    await getBusinessDayStartHour()
  );

  const sale = await tx.sale.create({
    data: {
      shopId: shop.id,
      recordedById: actor.userId,
      customerId: input.customerId ?? null,
      presetId,
      amount,
      paymentMethod: input.paymentMethod,
      isCustomAmount,
      businessDate,
      note: input.note ?? null,
    },
    include: SALE_INCLUDE,
  });

  // A sale is a visit. Phase 8's customer reports read this.
  if (input.customerId) {
    await tx.customer.update({
      where: { id: input.customerId },
      data: { lastSeenAt: sale.occurredAt },
    });
  }

  // §4.3: "every custom sale is flagged in the audit log."
  if (isCustomAmount) {
    await writeAudit(
      actor,
      {
        entity: "Sale",
        entityId: sale.id,
        action: "CUSTOM_AMOUNT",
        shopId: shop.id,
        after: { amount: amount.toString(), paymentMethod: input.paymentMethod },
      },
      tx
    );
  }

  return dto(sale);
}

/**
 * Resolve the sale amount from either a preset or a custom entry.
 *
 * The preset's amount is read from the DATABASE, never from the client. A
 * client that sends both a presetId and its own amount cannot make them
 * disagree, because the client's number is not consulted.
 */
async function resolveAmount(
  tx: Prisma.TransactionClient,
  shopId: string,
  allowCustomAmount: boolean,
  input: CreateSaleInput
): Promise<{
  amount: Prisma.Decimal;
  presetId: string | null;
  isCustomAmount: boolean;
}> {
  if (input.presetId) {
    const preset = await tx.salePreset.findUnique({
      where: { id: input.presetId },
    });

    // Scoped to the actor's own shop: a preset ID from another branch must not
    // work here, or one shop's price list leaks into another's takings.
    if (!preset || preset.shopId !== shopId) {
      throw notFound("That price is not available at this shop.");
    }
    if (!preset.isActive) {
      throw new AppError(
        "VALIDATION_FAILED",
        "That price is no longer offered. Pick another."
      );
    }

    return { amount: preset.amount, presetId: preset.id, isCustomAmount: false };
  }

  // Custom amount — off by default, enabled per shop (§4.3).
  if (!allowCustomAmount) {
    throw forbidden("This shop does not allow custom amounts.");
  }

  return {
    amount: new Prisma.Decimal(input.amount!),
    presetId: null,
    isCustomAmount: true,
  };
}

async function assertCustomerUsable(
  tx: Prisma.TransactionClient,
  customerId: string
): Promise<void> {
  const customer = await tx.customer.findUnique({
    where: { id: customerId },
    select: { id: true, isActive: true, mergedIntoId: true },
  });

  if (!customer || customer.mergedIntoId || !customer.isActive) {
    throw notFound("That customer no longer exists.");
  }
}

// ──────────────────────────────── Void ────────────────────────────────

/**
 * Void a sale (§4.3, §7.2 POST /api/sales/:id/void).
 *
 *   "Sales cannot be edited. They can be voided by an owner (any time) or a
 *    manager (same business day only), with a mandatory reason. A void creates
 *    a reversing record; the original row is never deleted."
 *
 * The schema models the reversal as a status flip plus void metadata rather
 * than a second Sale row — a negative sale would double the row count and every
 * report would have to remember to exclude it. `status = VOIDED` excludes it
 * from revenue by definition (§9), and the audit row is the permanent record of
 * who reversed it and why.
 *
 * STAFF may never void (§3.4).
 */
export async function voidSale(
  actor: Actor,
  saleId: string,
  input: VoidSaleInput,
  meta: { ipAddress?: string | null } = {}
): Promise<SaleDTO> {
  return prisma.$transaction(async (tx) => {
    const sale = await tx.sale.findUnique({
      where: { id: saleId },
      include: SALE_INCLUDE,
    });
    if (!sale) throw notFound("That sale no longer exists.");

    assertVoidable(actor, sale);

    const voided = await tx.sale.update({
      where: { id: saleId },
      data: {
        status: "VOIDED",
        voidedAt: new Date(),
        voidedById: actor.userId,
        voidReason: input.reason,
      },
      include: SALE_INCLUDE,
    });

    // The voided sale may have been this customer's most recent visit
    // (decision, Phase 2). Roll lastSeenAt back to the newest sale that still
    // counts, so visit history does not claim a visit that was reversed.
    if (sale.customerId) await refreshLastSeenAt(tx, sale.customerId);

    await writeAudit(
      actor,
      {
        entity: "Sale",
        entityId: sale.id,
        action: "VOID",
        shopId: sale.shopId,
        before: {
          status: sale.status,
          amount: sale.amount.toString(),
          paymentMethod: sale.paymentMethod,
        },
        after: { status: "VOIDED", amount: sale.amount.toString() },
        reason: input.reason,
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return dto(voided);
  });
}

/**
 * Who may void what (§3.4, §4.3).
 *
 * OWNER: any sale, any time.
 * MANAGER: their own shops, same business day only.
 * STAFF: never.
 */
function assertVoidable(actor: Actor, sale: Sale): void {
  if (sale.status === "VOIDED") {
    throw new AppError(
      "SALE_NOT_VOIDABLE",
      "That sale has already been voided."
    );
  }

  if (actor.role === "STAFF") {
    throw forbidden("Only a manager or the owner can void a sale.");
  }

  if (actor.role === "OWNER") return;

  // MANAGER from here down.
  if (!hasShopAccess(actor, sale.shopId)) {
    throw forbidden("You do not have access to that shop.");
  }

  // "same business day only" — compared against the actor's business date,
  // which is the day they are working, not the wall clock.
  const sameDay =
    sale.businessDate.getTime() === actor.businessDate.getTime();

  if (!sameDay) {
    throw new AppError(
      "SALE_NOT_VOIDABLE",
      "A manager can only void a sale on the same business day. Ask the owner to void this one."
    );
  }
}

// ──────────────────────────────── Read ────────────────────────────────

/**
 * List sales, scoped by role (§3.4, §7.2 GET /api/sales).
 *
 *   OWNER   — all shops.
 *   MANAGER — their assigned shops.
 *   STAFF   — their current shop, their own entries only.
 *
 * The scope is applied as a SQL filter that the caller's parameters cannot
 * widen: a `shopId` the actor may not see is rejected, not silently ignored,
 * so a manager probing another branch's ID gets a 403 rather than an empty list
 * they might mistake for "no sales today".
 */
export async function listSales(
  actor: Actor,
  input: ListSalesInput
): Promise<{ sales: SaleDTO[]; nextCursor: string | null }> {
  const where: Prisma.SaleWhereInput = {};

  if (input.shopId) {
    if (!hasShopAccess(actor, input.shopId)) {
      throw forbidden("You do not have access to that shop.");
    }
    where.shopId = input.shopId;
  } else if (actor.role === "MANAGER") {
    where.shopId = { in: actor.assignedShopIds };
  } else if (actor.role === "STAFF") {
    where.shopId = actor.workSession?.shopId ?? "__none__";
  }

  // STAFF see their own entries plus the shop's total count (§3.4) — the count
  // comes from `todaySummary`, this list is theirs alone.
  if (actor.role === "STAFF") {
    where.recordedById = actor.userId;
  } else if (input.userId) {
    where.recordedById = input.userId;
  }

  if (input.customerId) where.customerId = input.customerId;
  if (input.paymentMethod) where.paymentMethod = input.paymentMethod;

  const from = parseDateParam(input.from);
  const to = parseDateParam(input.to);
  if (from || to) {
    where.businessDate = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }

  const rows = await prisma.sale.findMany({
    where,
    include: SALE_INCLUDE,
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, PAGE_SIZE);

  return {
    sales: page.map(dto),
    nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
  };
}

function parseDateParam(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new AppError("VALIDATION_FAILED", "That date is not valid.");
  }
  return d;
}

export interface TodaySummary {
  shopId: string;
  shopName: string;
  businessDate: string;
  saleCount: number;
  total: string;
  byPaymentMethod: { CASH: { count: number; total: string }; EDC: { count: number; total: string } };
  /** The last few sales, for the strip at the bottom of the sale screen (§8.2). */
  recent: SaleDTO[];
  /** Whether this actor may void from that strip — a UI hint, not a permission. */
  canVoid: boolean;
}

/**
 * Today's totals for the current work-session shop (§7.2 GET
 * /api/sales/today-summary), plus the recent-sales strip from §8.2.
 *
 * Totals are aggregated in SQL — summing Decimal in JavaScript is exactly the
 * float hazard §4.1 forbids.
 */
export async function todaySummary(actor: WorkingActor): Promise<TodaySummary> {
  const shop = actor.workSession.shop;
  const businessDate = businessDateFor(
    new Date(),
    shop.timezone,
    await getBusinessDayStartHour()
  );

  const scope = {
    shopId: shop.id,
    businessDate,
    status: "COMPLETED",
  } satisfies Prisma.SaleWhereInput;

  const [totals, split, recentRows] = await Promise.all([
    prisma.sale.aggregate({
      where: scope,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.sale.groupBy({
      by: ["paymentMethod"],
      where: scope,
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.sale.findMany({
      // The strip shows the shop's recent activity, including sales already
      // voided today, so staff can see a correction actually took effect.
      where: {
        shopId: shop.id,
        businessDate,
        ...(actor.role === "STAFF" ? { recordedById: actor.userId } : {}),
      },
      include: SALE_INCLUDE,
      orderBy: { occurredAt: "desc" },
      take: 5,
    }),
  ]);

  const bucket = (method: "CASH" | "EDC") => {
    const row = split.find((s) => s.paymentMethod === method);
    return {
      count: row?._count._all ?? 0,
      total: (row?._sum.amount ?? new Prisma.Decimal(0)).toString(),
    };
  };

  return {
    shopId: shop.id,
    shopName: shop.name,
    businessDate: businessDate.toISOString().slice(0, 10),
    saleCount: totals._count._all,
    total: (totals._sum.amount ?? new Prisma.Decimal(0)).toString(),
    byPaymentMethod: { CASH: bucket("CASH"), EDC: bucket("EDC") },
    recent: recentRows.map(dto),
    canVoid: actor.role !== "STAFF",
  };
}
