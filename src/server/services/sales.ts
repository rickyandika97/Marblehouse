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
 * Sales are voided, which reverses them without deleting anything (§4.3).
 *
 * **§4.3's "sales cannot be edited" was relaxed for the OWNER on 21 Sep 2026
 * (D-181).** An owner may correct any field of any sale, and may restore a sale
 * that was voided by mistake, each with a mandatory reason and a full
 * before/after audit row. A manager's powers are unchanged: void only, same
 * business day only. Staff still have neither. Read D-181 before touching
 * `updateSale` or `unvoidSale`.
 */
import { z } from "zod";
import { Prisma, type Sale } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError, forbidden, notFound } from "@/server/errors";
import { writeAudit } from "@/server/audit";
import { businessDateFor } from "@/lib/business-date";
import { getBusinessDayStartHour } from "@/server/services/settings";
import { formatPhoneLocal } from "@/lib/phone";
import {
  assignedShopIds,
  hasShopAccess,
  roleAtShop,
  type Actor,
} from "@/server/auth/context";
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
  /**
   * Unset means BOTH — the list is a record of what was keyed in, and a void
   * that vanished from it would be invisible to the owner looking for the
   * mistake they are trying to correct (D-181). `COMPLETED` narrows it to what
   * counts as revenue (§9).
   */
  status: z.enum(["COMPLETED", "VOIDED"]).optional(),
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

  if (actor.isOwner) return;

  // MANAGER-at-this-shop from here down.
  if (roleAtShop(actor, sale.shopId) !== "MANAGER") {
    throw forbidden("Only a manager or the owner can void a sale.");
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

  // Role is per-shop (D-122): with no shopId given, fall back to every shop
  // this actor holds ANY role at (STAFF is filtered to their own entries
  // below regardless, so widening the shop set here does not widen what
  // rows they see — it only decides which shops' totals are even queried).
  if (input.shopId) {
    if (!hasShopAccess(actor, input.shopId)) {
      throw forbidden("You do not have access to that shop.");
    }
    where.shopId = input.shopId;
  } else if (!actor.isOwner) {
    where.shopId = { in: assignedShopIds(actor) };
  }

  // STAFF see their own entries plus the shop's total count (§3.4) — the count
  // comes from `todaySummary`, this list is theirs alone. With no shopId, use
  // the role at the shop actually in scope (the work-session shop) — a
  // MANAGER-at-that-shop sees everyone's entries there even if they are
  // STAFF elsewhere.
  const scopeShopId = input.shopId ?? actor.workSession?.shopId ?? null;
  const isStaffHere =
    !actor.isOwner &&
    (scopeShopId ? roleAtShop(actor, scopeShopId) === "STAFF" : true);
  if (isStaffHere) {
    where.recordedById = actor.userId;
    if (!input.shopId) where.shopId = actor.workSession?.shopId ?? "__none__";
  } else if (input.userId) {
    where.recordedById = input.userId;
  }

  if (input.customerId) where.customerId = input.customerId;
  if (input.paymentMethod) where.paymentMethod = input.paymentMethod;
  if (input.status) where.status = input.status;

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
  /** Whether this actor may EDIT from that strip (D-181, owner only). Also a hint. */
  canEdit: boolean;
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
        ...(roleAtShop(actor, shop.id) === "STAFF"
          ? { recordedById: actor.userId }
          : {}),
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
    canVoid: actor.isOwner || roleAtShop(actor, shop.id) === "MANAGER",
    canEdit: actor.isOwner,
  };
}

// ──────────────────────────────── Edit ────────────────────────────────

/**
 * Edit a sale (D-181) — OWNER ONLY.
 *
 * §4.3 says "sales cannot be edited". That rule was relaxed by the owner on
 * 21 Sep 2026 for the owner alone; see D-181 for the reasoning and for what a
 * manager may still do (void, same business day — unchanged). Read that entry
 * before narrowing or widening anything here.
 *
 * Every field the sale carries as a *fact about the transaction* is editable:
 * amount, payment method, customer, the staff member it is attributed to, the
 * shop, the date and time, and the note. What is NOT editable is the record of
 * the edit itself — the audit row, which is written on every call with a
 * mandatory reason and a full before/after snapshot.
 *
 * Three consequences worth understanding before changing this function:
 *
 *   1. **Moving `occurredAt` moves `businessDate`.** The business date is
 *      always recomputed from the new instant in the (possibly new) shop's
 *      timezone using the global start hour — it is never taken from the
 *      client (§6.1.4, D-18). So an edit can move money between reporting
 *      days, and yesterday's total can change after it was read. The owner
 *      accepted that explicitly; the audit row is what explains the change.
 *   2. **Moving the shop moves the revenue.** Both branches' reports change.
 *      HQ still refuses sales (§4.12), so a sale can never be moved onto it.
 *   3. **`lastSeenAt` is refreshed for BOTH customers** when the customer
 *      changes — the old one may have just lost their most recent visit, and
 *      the new one may have just gained one (D-12).
 *
 * `status` is edited only through `reason`-carrying un-void (see
 * `unvoidSale`), never here — an edit that silently resurrected a voided sale
 * would be indistinguishable from an edit that did not.
 */
export const updateSaleSchema = z
  .object({
    presetId: z.string().min(1).nullable().optional(),
    amount: z.number().int().positive().max(MAX_SALE_AMOUNT).optional(),
    paymentMethod: z.enum(["CASH", "EDC"]).optional(),
    customerId: z.string().min(1).nullable().optional(),
    recordedById: z.string().min(1).optional(),
    shopId: z.string().min(1).optional(),
    /** Full ISO instant. `businessDate` is derived from it, never sent. */
    occurredAt: z.string().datetime().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    reason: z
      .string()
      .trim()
      .min(3, "Say why this sale is being changed.")
      .max(500),
  })
  .refine((v) => !(v.presetId != null && v.amount !== undefined), {
    message: "Choose a preset amount, or enter a custom amount — not both.",
    path: ["presetId"],
  });

export const unvoidSaleSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(3, "Say why this void is being reversed.")
    .max(500),
});

export type UpdateSaleInput = z.infer<typeof updateSaleSchema>;
export type UnvoidSaleInput = z.infer<typeof unvoidSaleSchema>;

export async function updateSale(
  actor: Actor,
  saleId: string,
  input: UpdateSaleInput,
  meta: { ipAddress?: string | null } = {}
): Promise<SaleDTO> {
  // Owner only, and checked here rather than in the handler so that every
  // caller of this function is covered, not just the HTTP one (§3.4).
  if (!actor.isOwner) {
    throw forbidden("Only the owner can edit a sale.");
  }

  const startHour = await getBusinessDayStartHour();

  return prisma.$transaction(async (tx) => {
    const before = await tx.sale.findUnique({
      where: { id: saleId },
      include: SALE_INCLUDE,
    });
    if (!before) throw notFound("That sale no longer exists.");

    // A voided sale is a reversed sale. Editing one would produce a row whose
    // amount nobody ever took, and which no report counts — confusing rather
    // than useful. Un-void it first, then edit it.
    if (before.status === "VOIDED") {
      throw new AppError(
        "SALE_NOT_EDITABLE",
        "That sale is voided. Restore it first if you need to change it."
      );
    }

    // ── shop ──
    const shop = await resolveTargetShop(tx, before.shopId, input.shopId);

    // ── amount ──
    const { amount, presetId, isCustomAmount } = await resolveEditedAmount(
      tx,
      shop,
      before,
      input
    );

    // ── staff ──
    const recordedById = await resolveRecordedBy(
      tx,
      shop.id,
      before.recordedById,
      input.recordedById
    );

    // ── customer ──
    if (input.customerId) await assertCustomerUsable(tx, input.customerId);
    const customerId =
      input.customerId === undefined ? before.customerId : input.customerId;

    // ── when ──
    // Recomputed from the instant and the TARGET shop's timezone, so moving a
    // sale to a branch in another zone files it against the right day there.
    const occurredAt =
      input.occurredAt === undefined ? before.occurredAt : new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new AppError("VALIDATION_FAILED", "That date and time is not valid.");
    }
    if (occurredAt.getTime() > Date.now() + 60_000) {
      throw new AppError(
        "VALIDATION_FAILED",
        "A sale cannot be dated in the future."
      );
    }
    const businessDate = businessDateFor(occurredAt, shop.timezone, startHour);

    const updated = await tx.sale.update({
      where: { id: saleId },
      data: {
        shopId: shop.id,
        recordedById,
        customerId,
        presetId,
        amount,
        isCustomAmount,
        occurredAt,
        businessDate,
        ...(input.paymentMethod !== undefined
          ? { paymentMethod: input.paymentMethod }
          : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
      },
      include: SALE_INCLUDE,
    });

    // D-12: a visit that moved, was removed, or was gained. Refresh both
    // sides — the old customer may have lost their most recent sale, and the
    // new one may have gained one. Order does not matter; they are distinct
    // rows by the time we get here.
    const touched = new Set(
      [before.customerId, updated.customerId].filter((id): id is string => id !== null)
    );
    for (const id of touched) await refreshLastSeenAt(tx, id);

    await writeAudit(
      actor,
      {
        entity: "Sale",
        entityId: saleId,
        action: "UPDATE",
        // The shop the sale BELONGED to. A move is visible in before/after;
        // filing the audit row under the destination would hide the change
        // from the source branch's own audit view.
        shopId: before.shopId,
        before: saleAuditSnapshot(before),
        after: saleAuditSnapshot(updated),
        reason: input.reason,
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return dto(updated);
  });
}

/** The fields an edit may change, as a flat JSON snapshot for the audit row. */
function saleAuditSnapshot(s: {
  shopId: string;
  recordedById: string;
  customerId: string | null;
  presetId: string | null;
  amount: Prisma.Decimal;
  paymentMethod: string;
  isCustomAmount: boolean;
  status: string;
  occurredAt: Date;
  businessDate: Date;
  note: string | null;
}): Prisma.InputJsonValue {
  return {
    shopId: s.shopId,
    recordedById: s.recordedById,
    customerId: s.customerId,
    presetId: s.presetId,
    // String, never a number — D-13 applies to the audit log too, which is
    // where a figure is read back years later.
    amount: s.amount.toString(),
    paymentMethod: s.paymentMethod,
    isCustomAmount: s.isCustomAmount,
    status: s.status,
    occurredAt: s.occurredAt.toISOString(),
    businessDate: s.businessDate.toISOString().slice(0, 10),
    note: s.note,
  };
}

/** The shop the sale will belong to after the edit. */
async function resolveTargetShop(
  tx: Prisma.TransactionClient,
  currentShopId: string,
  requestedShopId: string | undefined
) {
  const shopId = requestedShopId ?? currentShopId;
  const shop = await tx.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw notFound("That shop no longer exists.");

  // §4.12 — HQ is expense-only. It refuses a sale moved onto it for exactly
  // the same reason it refuses one recorded on it.
  if (shop.isHqPseudoShop) {
    throw new AppError(
      "VALIDATION_FAILED",
      "HQ does not record sales. Choose a branch."
    );
  }
  return shop;
}

/**
 * The amount after the edit, and whether it is now a preset or a custom entry.
 *
 * Unchanged when the request names neither — an edit that only moves the date
 * must not silently re-price the sale. As on create, a preset's amount is read
 * from the DATABASE and scoped to the target shop (D-15): moving a sale to
 * another branch cannot carry the source branch's price list with it.
 *
 * `allowCustomAmount` is deliberately NOT consulted. That flag governs what
 * staff may key in at the till; the owner correcting a mistyped figure months
 * later is a different act, and a branch that has since turned the flag off
 * would otherwise become unable to fix its own history.
 */
async function resolveEditedAmount(
  tx: Prisma.TransactionClient,
  shop: { id: string },
  before: Sale,
  input: UpdateSaleInput
): Promise<{
  amount: Prisma.Decimal;
  presetId: string | null;
  isCustomAmount: boolean;
}> {
  if (input.presetId) {
    const preset = await tx.salePreset.findUnique({
      where: { id: input.presetId },
    });
    if (!preset || preset.shopId !== shop.id) {
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

  if (input.amount !== undefined) {
    return {
      amount: new Prisma.Decimal(input.amount),
      presetId: null,
      isCustomAmount: true,
    };
  }

  // Neither given. Keep the amount — but a sale MOVED to another shop can no
  // longer point at its old shop's preset, so drop the link and keep the
  // figure. The amount the customer paid is the fact; the preset is only how
  // it was entered.
  if (before.presetId && before.shopId !== shop.id) {
    return {
      amount: before.amount,
      presetId: null,
      isCustomAmount: before.isCustomAmount,
    };
  }

  return {
    amount: before.amount,
    presetId: before.presetId,
    isCustomAmount: before.isCustomAmount,
  };
}

/**
 * The user the sale is attributed to after the edit.
 *
 * Must be active and hold some role at the target shop — attributing a sale to
 * someone who has never worked at that branch would corrupt Sales by Staff
 * (§9) with a row that cannot be explained. The OWNER passes regardless: they
 * hold no `UserShop` row anywhere by design (D-122) and may legitimately have
 * rung a sale themselves.
 */
async function resolveRecordedBy(
  tx: Prisma.TransactionClient,
  shopId: string,
  currentUserId: string,
  requestedUserId: string | undefined
): Promise<string> {
  if (requestedUserId === undefined || requestedUserId === currentUserId) {
    return currentUserId;
  }

  const user = await tx.user.findUnique({
    where: { id: requestedUserId },
    select: {
      id: true,
      banned: true,
      isOwner: true,
      userShops: { where: { shopId }, select: { shopId: true } },
    },
  });

  if (!user || user.banned) {
    throw notFound("That staff member no longer exists.");
  }
  if (!user.isOwner && user.userShops.length === 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "That staff member does not work at this shop."
    );
  }
  return user.id;
}

// ─────────────────────────────── Un-void ───────────────────────────────

/**
 * Restore a voided sale (D-181) — OWNER ONLY.
 *
 * The mirror image of `voidSale`: `status` goes back to COMPLETED and the void
 * metadata is cleared, so the row counts towards revenue again (§9). The void
 * itself is NOT erased — the original VOID audit row stays, and this writes an
 * `UNVOID` row beside it, so the sequence reads as what actually happened
 * rather than as a sale that was never reversed.
 *
 * Exists because a mis-tapped void was previously unfixable: the only recovery
 * was recording a second sale, which left the shop's transaction count one too
 * high forever.
 */
export async function unvoidSale(
  actor: Actor,
  saleId: string,
  input: UnvoidSaleInput,
  meta: { ipAddress?: string | null } = {}
): Promise<SaleDTO> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can restore a voided sale.");
  }

  return prisma.$transaction(async (tx) => {
    const sale = await tx.sale.findUnique({
      where: { id: saleId },
      include: SALE_INCLUDE,
    });
    if (!sale) throw notFound("That sale no longer exists.");

    if (sale.status !== "VOIDED") {
      throw new AppError(
        "SALE_NOT_EDITABLE",
        "That sale is not voided, so there is nothing to restore."
      );
    }

    const restored = await tx.sale.update({
      where: { id: saleId },
      data: {
        status: "COMPLETED",
        voidedAt: null,
        voidedById: null,
        voidReason: null,
      },
      include: SALE_INCLUDE,
    });

    // The restored sale may now be this customer's most recent visit again
    // (D-12, in reverse).
    if (restored.customerId) await refreshLastSeenAt(tx, restored.customerId);

    await writeAudit(
      actor,
      {
        entity: "Sale",
        entityId: saleId,
        action: "UNVOID",
        shopId: sale.shopId,
        before: {
          status: "VOIDED",
          amount: sale.amount.toString(),
          voidReason: sale.voidReason,
          voidedAt: sale.voidedAt?.toISOString() ?? null,
        },
        after: { status: "COMPLETED", amount: sale.amount.toString() },
        reason: input.reason,
        ipAddress: meta.ipAddress ?? null,
      },
      tx
    );

    return dto(restored);
  });
}

// ─────────────────────── Options for the edit form ───────────────────────

export interface SaleEditOptions {
  shops: { id: string; name: string; code: string }[];
  /** Presets of every selectable shop, so the form can re-key when the shop changes. */
  presetsByShop: Record<string, PresetDTO[]>;
  /** Who a sale may be attributed to, per shop. The owner appears in every list. */
  staffByShop: Record<string, { id: string; displayName: string }[]>;
}

/**
 * Everything the owner's edit form needs to offer a choice (D-181).
 *
 * Returned as one payload rather than three endpoints because the three are
 * only meaningful together: changing the shop must immediately re-offer THAT
 * shop's presets and THAT shop's staff, and a form that fetches them on change
 * shows an empty list for as long as the shop wifi takes. Every shop's lists
 * are small (a price list and a branch roster), so sending them all costs less
 * than the round trips it saves.
 *
 * OWNER only — it is the edit form's data, and the edit is owner-only.
 * HQ is excluded: a sale can never be moved onto it (§4.12).
 */
export async function saleEditOptions(actor: Actor): Promise<SaleEditOptions> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can edit a sale.");
  }

  const [shops, presets, owners, userShops] = await Promise.all([
    prisma.shop.findMany({
      where: { isActive: true, isHqPseudoShop: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, code: true },
    }),
    prisma.salePreset.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { amount: "asc" }],
    }),
    // Owners hold no UserShop row by design (D-122), so they would otherwise
    // be missing from every branch's list — including for the sales they rang
    // themselves.
    prisma.user.findMany({
      where: { isOwner: true, banned: { not: true } },
      orderBy: { displayName: "asc" },
      select: { id: true, displayName: true },
    }),
    prisma.userShop.findMany({
      where: { user: { banned: { not: true } } },
      orderBy: { user: { displayName: "asc" } },
      select: {
        shopId: true,
        user: { select: { id: true, displayName: true } },
      },
    }),
  ]);

  const presetsByShop: Record<string, PresetDTO[]> = {};
  const staffByShop: Record<string, { id: string; displayName: string }[]> = {};

  for (const shop of shops) {
    presetsByShop[shop.id] = [];
    staffByShop[shop.id] = [...owners];
  }

  for (const p of presets) {
    presetsByShop[p.shopId]?.push({
      id: p.id,
      label: p.label,
      amount: p.amount.toString(),
      sortOrder: p.sortOrder,
    });
  }

  for (const us of userShops) {
    // A user can hold a role at several shops; each appears once per shop.
    staffByShop[us.shopId]?.push(us.user);
  }

  return { shops, presetsByShop, staffByShop };
}
