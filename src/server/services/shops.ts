/**
 * Shop administration (PRD §5.6, §7.9, §8.10 "Owner: Shops").
 *
 * Creating and editing branches. OWNER only — §3.4's permission matrix gives
 * "Create / edit shop" to the owner and to nobody else, and every function
 * here re-checks that rather than trusting the route guard.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A new shop starts EMPTY. No presets, no shifts, no clone.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * §5.6 specifies a clone step — "clones sale presets and shifts from an
 * existing shop as a starting point" — and this deliberately does NOT
 * implement it (owner decision, 18 Aug 2026; BUILD-LOG D-101). Cloning copies
 * money amounts and opening hours from one branch to another, and a preset
 * that is silently wrong is worse than a preset that is visibly absent: staff
 * would sell at the old branch's prices without anyone choosing that. The
 * owner asked for the simple flow, and adding presets is a screen that already
 * exists.
 *
 * The consequence is real and the UI must say so: a brand-new shop can take no
 * sale until a preset is added, because `createSale` requires either a preset
 * or `allowCustomAmount`. That is a visible, self-correcting emptiness.
 *
 * There is deliberately no delete. A shop owns sales, ledger rows, batches and
 * attendance; CLAUDE.md's soft-delete rule covers all of it. `isActive: false`
 * is the retirement path, and it keeps every historical report intact.
 */
import { z } from "zod";
import { Prisma, type Shop } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError, forbidden, notFound } from "@/server/errors";
import { writeAudit } from "@/server/audit";
import type { Actor } from "@/server/auth/context";

// ─────────────────────────────── Schemas ───────────────────────────────

/**
 * The branch code. Uppercased on the way in so `br-2` and `BR-2` cannot both
 * exist — the column is `@unique`, but Postgres uniqueness is case-SENSITIVE,
 * so without this the database would happily accept both and every human
 * reading a report would treat them as one branch.
 */
const code = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, "The code must be at least 2 characters.")
  .max(12, "The code must be 12 characters or fewer.")
  .regex(
    /^[A-Z0-9-]+$/,
    "Use capital letters, numbers and dashes only — for example BR-2.",
  );

/**
 * An IANA zone name. Validated against the runtime's own tz database rather
 * than a hand-kept list: a typo here misfiles every business date at the
 * branch, and the failure would look like a reporting bug months later.
 */
const timezone = z
  .string()
  .trim()
  .min(1, "Choose a timezone.")
  .refine(isValidTimezone, "That is not a recognised timezone name.");

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Shared editable fields. NOTE what is absent: `isHqPseudoShop`. HQ is the
 * seed's expense-only pseudo-shop (§4.12) and there is exactly one; letting
 * the owner mint a second — or flip a real trading branch into one — would
 * quietly remove it from every sale picker and dashboard. It is not editable
 * here by design.
 *
 * Day-start hour is absent too, and that is not an oversight: the reporting
 * cutoff is GLOBAL (§4.2, D-18) and lives in Settings → System. §5.6 lists it
 * on this form; §5.6 predates D-18.
 */
const shopFields = {
  name: z.string().trim().min(1, "Enter a name.").max(80),
  address: z.string().trim().max(300).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  timezone,
  lateGraceMin: z
    .number()
    .int("Enter a whole number of minutes.")
    .min(0, "Grace cannot be negative.")
    .max(120, "120 minutes is the maximum grace.")
    .default(5),
  allowCustomAmount: z.boolean().default(false),
  allowDirectTransfer: z.boolean().default(false),
  requireClockOutPhoto: z.boolean().default(true),
};

export const createShopSchema = z.object({
  code,
  ...shopFields,
  timezone: timezone.default("Asia/Jakarta"),
});

/**
 * `code` is deliberately absent — it is IMMUTABLE after creation, the same
 * call as `User.username` (D-3).
 *
 * The code is what a human uses to identify a branch on an exported CSV, in
 * the audit log and in conversation. Those references are already printed and
 * already filed; renaming BR-2 to BR-7 would silently re-point every one of
 * them. `name` is the mutable, human-facing label — change that instead.
 */
export const updateShopSchema = z.object({
  name: shopFields.name.optional(),
  address: shopFields.address,
  phone: shopFields.phone,
  timezone: timezone.optional(),
  lateGraceMin: shopFields.lateGraceMin.optional(),
  allowCustomAmount: z.boolean().optional(),
  allowDirectTransfer: z.boolean().optional(),
  requireClockOutPhoto: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export type CreateShopInput = z.infer<typeof createShopSchema>;
export type UpdateShopInput = z.infer<typeof updateShopSchema>;

// ─────────────────────────────── DTO ───────────────────────────────

/**
 * Shop DTO. Carries no cost figures of any kind, so there is no restricted
 * variant to build — a shop row holds settings, not money.
 */
export function toShopDTO(
  shop: Shop & { _count?: { presets: number; shifts: number; userShops: number } },
) {
  return {
    id: shop.id,
    code: shop.code,
    name: shop.name,
    address: shop.address,
    phone: shop.phone,
    timezone: shop.timezone,
    lateGraceMin: shop.lateGraceMin,
    allowCustomAmount: shop.allowCustomAmount,
    allowDirectTransfer: shop.allowDirectTransfer,
    requireClockOutPhoto: shop.requireClockOutPhoto,
    isHqPseudoShop: shop.isHqPseudoShop,
    isActive: shop.isActive,
    /**
     * Surfaced so the list can warn "no presets — this branch cannot take a
     * sale yet". That warning is the whole reason the empty-start decision is
     * safe to ship.
     */
    presetCount: shop._count?.presets ?? 0,
    shiftCount: shop._count?.shifts ?? 0,
    /**
     * Assigned managers and staff. NOT a count of who can reach the shop — an
     * OWNER needs no assignment (§3.1) and is never counted here. Zero means
     * the branch is absent from every non-owner's shop picker.
     */
    staffCount: shop._count?.userShops ?? 0,
  };
}

export type ShopDTO = ReturnType<typeof toShopDTO>;

// ─────────────────────────────── Queries ───────────────────────────────

/**
 * Every shop, for the admin screen. OWNER only.
 *
 * Unlike `selectableShops`, this includes HQ and inactive branches — it is the
 * administration list, so it must show what is there rather than what is
 * usable today.
 */
export async function listShops(actor: Actor): Promise<ShopDTO[]> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can manage shops.");
  }

  const shops = await prisma.shop.findMany({
    include: { _count: { select: { presets: true, shifts: true, userShops: true } } },
    // HQ first and visually set apart (D-128) — it is not a trading branch,
    // and the owner should never have to scan past it to tell which rows can
    // take a sale. Active branches next, inactive ones last within that.
    orderBy: [
      { isHqPseudoShop: "desc" },
      { isActive: "desc" },
      { name: "asc" },
    ],
  });

  return shops.map(toShopDTO);
}

export async function getShop(actor: Actor, id: string): Promise<ShopDTO> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can manage shops.");
  }

  const shop = await prisma.shop.findUnique({
    where: { id },
    include: { _count: { select: { presets: true, shifts: true, userShops: true } } },
  });
  if (!shop) throw notFound("That shop no longer exists.");

  return toShopDTO(shop);
}

// ─────────────────────────────── Mutations ───────────────────────────────

/**
 * Create a branch (§5.6). OWNER only.
 *
 * The new shop starts with no presets, no shifts and nobody assigned — see the
 * note at the top of this file. Three follow-up steps are the owner's, and the
 * UI names all three: add sale presets, add shifts, assign staff.
 */
export async function createShop(
  actor: Actor,
  input: CreateShopInput,
  meta: { ipAddress?: string | null } = {},
): Promise<ShopDTO> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can create shops.");
  }

  // Checked up front so the message names the real problem. The unique index
  // is still the arbiter — see the P2002 catch below, which is what actually
  // holds under two owners submitting at once.
  const taken = await prisma.shop.findUnique({
    where: { code: input.code },
    select: { id: true, name: true },
  });
  if (taken) {
    throw new AppError("CONFLICT", `The code ${input.code} is already used by ${taken.name}.`, {
      fields: { code: "That code is already in use." },
    });
  }

  let created;
  try {
    created = await prisma.shop.create({
      data: {
        code: input.code,
        name: input.name,
        address: input.address || null,
        phone: input.phone || null,
        timezone: input.timezone,
        lateGraceMin: input.lateGraceMin,
        allowCustomAmount: input.allowCustomAmount,
        allowDirectTransfer: input.allowDirectTransfer,
        requireClockOutPhoto: input.requireClockOutPhoto,
        // Never settable from input — see the note on `shopFields`.
        isHqPseudoShop: false,
      },
      include: { _count: { select: { presets: true, shifts: true, userShops: true } } },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new AppError("CONFLICT", "That code is already in use.", {
        fields: { code: "That code is already in use." },
      });
    }
    throw e;
  }

  await writeAudit(actor, {
    entity: "Shop",
    entityId: created.id,
    action: "CREATE",
    // The audited shop is the NEW one, not wherever the owner happens to be
    // working today — `writeAudit` would otherwise default to their session.
    shopId: created.id,
    after: {
      code: created.code,
      name: created.name,
      timezone: created.timezone,
      lateGraceMin: created.lateGraceMin,
      allowCustomAmount: created.allowCustomAmount,
      allowDirectTransfer: created.allowDirectTransfer,
      requireClockOutPhoto: created.requireClockOutPhoto,
    },
    ipAddress: meta.ipAddress ?? null,
  });

  return toShopDTO(created);
}

/**
 * Edit a branch, including retiring it. OWNER only.
 *
 * §11 lists "shop setting change" as an audited event, so every change here
 * writes before/after.
 */
export async function updateShop(
  actor: Actor,
  id: string,
  input: UpdateShopInput,
  meta: { ipAddress?: string | null } = {},
): Promise<ShopDTO> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can edit shops.");
  }

  const existing = await prisma.shop.findUnique({ where: { id } });
  if (!existing) throw notFound("That shop no longer exists.");

  /**
   * HQ must stay reachable. It is the only place non-branch expenses can be
   * booked (§4.12), and `expenseShops` filters on `isActive` — deactivating it
   * would remove the option with no way to book head-office costs and no
   * obvious cause.
   */
  if (existing.isHqPseudoShop && input.isActive === false) {
    throw new AppError(
      "VALIDATION_FAILED",
      "HQ cannot be deactivated — it is where head-office expenses are recorded.",
      { fields: { isActive: "HQ must stay active." } },
    );
  }

  /**
   * Never retire the last trading branch. Without this the owner can reach a
   * state where the day-start picker is empty, nobody can declare a work
   * session, and therefore nobody can record anything at all — recoverable
   * only from the database.
   */
  if (input.isActive === false && existing.isActive && !existing.isHqPseudoShop) {
    const otherActive = await prisma.shop.count({
      where: { isActive: true, isHqPseudoShop: false, id: { not: id } },
    });
    if (otherActive === 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "This is the last active branch. Create another before deactivating this one.",
        { fields: { isActive: "The last active branch must stay open." } },
      );
    }
  }

  const updated = await prisma.shop.update({
    where: { id },
    data: {
      name: input.name ?? undefined,
      address: input.address === undefined ? undefined : input.address || null,
      phone: input.phone === undefined ? undefined : input.phone || null,
      timezone: input.timezone ?? undefined,
      lateGraceMin: input.lateGraceMin ?? undefined,
      allowCustomAmount: input.allowCustomAmount ?? undefined,
      allowDirectTransfer: input.allowDirectTransfer ?? undefined,
      requireClockOutPhoto: input.requireClockOutPhoto ?? undefined,
      isActive: input.isActive ?? undefined,
      // `code` and `isHqPseudoShop` are absent on purpose — both immutable.
    },
    include: { _count: { select: { presets: true, shifts: true, userShops: true } } },
  });

  await writeAudit(actor, {
    entity: "Shop",
    entityId: id,
    action:
      input.isActive === false
        ? "DEACTIVATE"
        : input.isActive === true && !existing.isActive
          ? "REACTIVATE"
          : "UPDATE",
    shopId: id,
    before: {
      name: existing.name,
      address: existing.address,
      phone: existing.phone,
      timezone: existing.timezone,
      lateGraceMin: existing.lateGraceMin,
      allowCustomAmount: existing.allowCustomAmount,
      allowDirectTransfer: existing.allowDirectTransfer,
      requireClockOutPhoto: existing.requireClockOutPhoto,
      isActive: existing.isActive,
    },
    after: {
      name: updated.name,
      address: updated.address,
      phone: updated.phone,
      timezone: updated.timezone,
      lateGraceMin: updated.lateGraceMin,
      allowCustomAmount: updated.allowCustomAmount,
      allowDirectTransfer: updated.allowDirectTransfer,
      requireClockOutPhoto: updated.requireClockOutPhoto,
      isActive: updated.isActive,
    },
    ipAddress: meta.ipAddress ?? null,
  });

  return toShopDTO(updated);
}

// ══════════════════════════ Sale presets (§4.3, §7.2) ══════════════════════════
//
// Presets are per shop, and the owner may "add, edit, reorder, or deactivate"
// them (§4.3). D-101 made a new branch start empty, so this is the screen that
// makes an empty branch usable — without it, creating a shop is a dead end.
//
// ───────────────────────────────────────────────────────────────────────────
// THE RULE THAT SHAPES THIS FILE (§4.3):
//
//   "A preset that has been used in a sale can be deactivated but never
//    deleted or edited in a way that changes its amount. Editing an amount
//    creates a NEW preset version and deactivates the old one."
//
// A sale stores `presetId`, not a copy of the amount. So editing 50.000 to
// 60.000 in place would silently rewrite every historical sale that points at
// it — last month's revenue report would change. `updatePreset` therefore
// SUPERSEDES rather than mutates when the amount changes on a used preset, and
// `deletePreset` refuses outright once a sale references it.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Money arrives as a STRING and is parsed to Decimal, never through a JS
 * number (§4.1). Whole rupiah only — IDR has no subunit in practice, and a
 * preset is a button on a till, not a computed figure.
 */
const presetAmount = z
  .string()
  .trim()
  .min(1, "Enter an amount.")
  .regex(/^\d+$/, "Enter whole rupiah, digits only — for example 50000.")
  .refine((v) => v.replace(/^0+/, "").length > 0, "The amount must be more than zero.")
  .refine((v) => v.length <= 12, "That amount is too large.");

export const createPresetSchema = z.object({
  label: z.string().trim().min(1, "Enter a label.").max(40),
  amount: presetAmount,
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

/**
 * `amount` is present but its handling is special — see `updatePreset`. A
 * change to the amount of a preset that has been SOLD does not edit the row;
 * it supersedes it.
 */
export const updatePresetSchema = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  amount: presetAmount.optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
});

export type CreatePresetInput = z.infer<typeof createPresetSchema>;
export type UpdatePresetInput = z.infer<typeof updatePresetSchema>;

export interface PresetAdminDTO {
  id: string;
  label: string;
  /** A string, never a JSON number — `Decimal` → number is the float bug (D-13). */
  amount: string;
  sortOrder: number;
  isActive: boolean;
  /** Whether a sale points at this row. Drives "deactivate" vs "delete" in the UI. */
  useCount: number;
}

function toPresetAdminDTO(
  p: { id: string; label: string; amount: Prisma.Decimal; sortOrder: number; isActive: boolean },
  useCount: number,
): PresetAdminDTO {
  return {
    id: p.id,
    label: p.label,
    amount: p.amount.toString(),
    sortOrder: p.sortOrder,
    isActive: p.isActive,
    useCount,
  };
}

/** OWNER-only, and the shop must exist. Shared by every function below. */
async function requireOwnerAndShop(actor: Actor, shopId: string) {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can manage sale prices.");
  }
  const shop = await prisma.shop.findUnique({ where: { id: shopId } });
  if (!shop) throw notFound("That shop no longer exists.");
  return shop;
}

/**
 * Every preset for the admin screen, active and inactive.
 *
 * Deliberately NOT `listPresets` in `sales.ts` — that one is the sale screen's
 * query and returns active presets only, with no use counts. Two different
 * questions.
 */
export async function listPresetsForAdmin(
  actor: Actor,
  shopId: string,
): Promise<PresetAdminDTO[]> {
  await requireOwnerAndShop(actor, shopId);

  const presets = await prisma.salePreset.findMany({
    where: { shopId },
    include: { _count: { select: { sales: true } } },
    // Active first, then the owner's chosen order — matching the sale screen.
    orderBy: [{ isActive: "desc" }, { sortOrder: "asc" }, { amount: "asc" }],
  });

  return presets.map((p) => toPresetAdminDTO(p, p._count.sales));
}

export async function createPreset(
  actor: Actor,
  shopId: string,
  input: CreatePresetInput,
  meta: { ipAddress?: string | null } = {},
): Promise<PresetAdminDTO> {
  await requireOwnerAndShop(actor, shopId);

  const amount = new Prisma.Decimal(input.amount);
  if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
    throw new AppError("VALIDATION_FAILED", "The amount must be more than zero.", {
      fields: { amount: "The amount must be more than zero." },
    });
  }

  // Two buttons with the same price on one till is a mis-tap waiting to
  // happen, and there is no legitimate reason for it.
  const clash = await prisma.salePreset.findFirst({
    where: { shopId, amount, isActive: true },
  });
  if (clash) {
    throw new AppError(
      "CONFLICT",
      `This shop already has an active price of ${amount.toString()}.`,
      { fields: { amount: "That price already exists here." } },
    );
  }

  // Default to the end of the list rather than 0, so a new price does not
  // silently jump to the front of the till.
  const sortOrder = input.sortOrder ?? (await nextSortOrder(shopId));

  const created = await prisma.salePreset.create({
    data: { shopId, label: input.label, amount, sortOrder },
  });

  await writeAudit(actor, {
    entity: "SalePreset",
    entityId: created.id,
    action: "CREATE",
    shopId,
    after: { label: created.label, amount: created.amount.toString(), sortOrder },
    ipAddress: meta.ipAddress ?? null,
  });

  return toPresetAdminDTO(created, 0);
}

async function nextSortOrder(shopId: string): Promise<number> {
  const last = await prisma.salePreset.findFirst({
    where: { shopId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? 0) + 1;
}

/**
 * Edit a preset — with §4.3's supersede rule.
 *
 * Three cases, and the third is the one that matters:
 *
 *  1. Label / order / active only → a plain update. Amount untouched.
 *  2. Amount changed, preset **never sold** → a plain update. Nothing points
 *     at it, so there is no history to protect.
 *  3. Amount changed, preset **has sales** → the old row is DEACTIVATED and a
 *     NEW preset is created at the new amount. Both happen in one transaction.
 *     Historical sales keep pointing at the old row and keep their old amount.
 *
 * Case 3 returns the NEW preset, and the response carries `supersededId` so
 * the UI can explain what happened rather than appearing to duplicate a row.
 */
export async function updatePreset(
  actor: Actor,
  shopId: string,
  presetId: string,
  input: UpdatePresetInput,
  meta: { ipAddress?: string | null } = {},
): Promise<PresetAdminDTO & { supersededId?: string }> {
  await requireOwnerAndShop(actor, shopId);

  const existing = await prisma.salePreset.findUnique({
    where: { id: presetId },
    include: { _count: { select: { sales: true } } },
  });
  if (!existing || existing.shopId !== shopId) {
    throw notFound("That sale price no longer exists.");
  }

  const nextAmount =
    input.amount === undefined ? existing.amount : new Prisma.Decimal(input.amount);

  if (!nextAmount.isFinite() || nextAmount.lessThanOrEqualTo(0)) {
    throw new AppError("VALIDATION_FAILED", "The amount must be more than zero.", {
      fields: { amount: "The amount must be more than zero." },
    });
  }

  const amountChanged = !nextAmount.equals(existing.amount);
  const hasSales = existing._count.sales > 0;

  // ── Case 3: supersede ────────────────────────────────────────────────────
  if (amountChanged && hasSales) {
    const result = await prisma.$transaction(async (tx) => {
      await tx.salePreset.update({
        where: { id: presetId },
        data: { isActive: false },
      });

      const replacement = await tx.salePreset.create({
        data: {
          shopId,
          label: input.label ?? existing.label,
          amount: nextAmount,
          sortOrder: input.sortOrder ?? existing.sortOrder,
        },
      });

      await writeAudit(
        actor,
        {
          entity: "SalePreset",
          entityId: replacement.id,
          action: "SUPERSEDE",
          shopId,
          before: {
            id: existing.id,
            label: existing.label,
            amount: existing.amount.toString(),
            salesUsingIt: existing._count.sales,
          },
          after: {
            id: replacement.id,
            label: replacement.label,
            amount: replacement.amount.toString(),
          },
          reason:
            "The amount changed on a preset with sales against it (§4.3): the old price was deactivated and a new one created, so historical sales keep their original amount.",
          ipAddress: meta.ipAddress ?? null,
        },
        tx,
      );

      return replacement;
    });

    return { ...toPresetAdminDTO(result, 0), supersededId: existing.id };
  }

  // ── Cases 1 and 2: a plain update ────────────────────────────────────────
  if (amountChanged) {
    const clash = await prisma.salePreset.findFirst({
      where: { shopId, amount: nextAmount, isActive: true, id: { not: presetId } },
    });
    if (clash) {
      throw new AppError(
        "CONFLICT",
        `This shop already has an active price of ${nextAmount.toString()}.`,
        { fields: { amount: "That price already exists here." } },
      );
    }
  }

  const updated = await prisma.salePreset.update({
    where: { id: presetId },
    data: {
      label: input.label ?? undefined,
      amount: amountChanged ? nextAmount : undefined,
      sortOrder: input.sortOrder ?? undefined,
      isActive: input.isActive ?? undefined,
    },
  });

  await writeAudit(actor, {
    entity: "SalePreset",
    entityId: presetId,
    action:
      input.isActive === false
        ? "DEACTIVATE"
        : input.isActive === true && !existing.isActive
          ? "REACTIVATE"
          : "UPDATE",
    shopId,
    before: {
      label: existing.label,
      amount: existing.amount.toString(),
      sortOrder: existing.sortOrder,
      isActive: existing.isActive,
    },
    after: {
      label: updated.label,
      amount: updated.amount.toString(),
      sortOrder: updated.sortOrder,
      isActive: updated.isActive,
    },
    ipAddress: meta.ipAddress ?? null,
  });

  return toPresetAdminDTO(updated, existing._count.sales);
}

/**
 * Delete a preset — only if it has never been sold.
 *
 * §13.5 permits a hard delete for an UNUSED sale preset specifically, which is
 * why this is a real delete and not a soft one. The moment a sale references
 * it, the row is history and deactivating is the only option.
 */
export async function deletePreset(
  actor: Actor,
  shopId: string,
  presetId: string,
  meta: { ipAddress?: string | null } = {},
): Promise<{ deleted: true }> {
  await requireOwnerAndShop(actor, shopId);

  const existing = await prisma.salePreset.findUnique({
    where: { id: presetId },
    include: { _count: { select: { sales: true } } },
  });
  if (!existing || existing.shopId !== shopId) {
    throw notFound("That sale price no longer exists.");
  }

  if (existing._count.sales > 0) {
    throw new AppError(
      "CONFLICT",
      `${existing._count.sales} ${existing._count.sales === 1 ? "sale uses" : "sales use"} this price, so it cannot be deleted. Deactivate it instead — it will stop appearing on the sale screen and past sales stay correct.`,
      { usageCount: existing._count.sales },
    );
  }

  await prisma.salePreset.delete({ where: { id: presetId } });

  await writeAudit(actor, {
    entity: "SalePreset",
    entityId: presetId,
    action: "DELETE",
    shopId,
    before: {
      label: existing.label,
      amount: existing.amount.toString(),
      sortOrder: existing.sortOrder,
    },
    ipAddress: meta.ipAddress ?? null,
  });

  return { deleted: true };
}

/**
 * The seed's five default prices (§4.3), offered as a one-tap starting point
 * on an empty branch.
 *
 * This is NOT the §5.6 clone step D-101 rejected. Cloning copies another
 * branch's real, possibly-tuned prices with no indication of where they came
 * from. This inserts the documented defaults, on an explicit tap, only when
 * the shop has none — the owner sees exactly what they are getting and can
 * edit or delete any of them straight away.
 */
export const DEFAULT_PRESET_AMOUNTS = [20000, 50000, 100000, 200000, 500000];

export async function addDefaultPresets(
  actor: Actor,
  shopId: string,
  meta: { ipAddress?: string | null } = {},
): Promise<PresetAdminDTO[]> {
  await requireOwnerAndShop(actor, shopId);

  // Only on a genuinely empty branch. Otherwise a second tap would either
  // duplicate prices or half-fail on the uniqueness check.
  const existing = await prisma.salePreset.count({ where: { shopId } });
  if (existing > 0) {
    throw new AppError(
      "CONFLICT",
      "This shop already has sale prices. Add them one at a time instead.",
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.salePreset.createMany({
      data: DEFAULT_PRESET_AMOUNTS.map((amount, i) => ({
        shopId,
        label: `Rp ${amount.toLocaleString("id-ID")}`,
        amount: new Prisma.Decimal(amount),
        sortOrder: i + 1,
      })),
    });

    await writeAudit(
      actor,
      {
        entity: "SalePreset",
        entityId: shopId,
        action: "CREATE_DEFAULTS",
        shopId,
        after: { amounts: DEFAULT_PRESET_AMOUNTS },
        ipAddress: meta.ipAddress ?? null,
      },
      tx,
    );
  });

  return listPresetsForAdmin(actor, shopId);
}
