/**
 * Global application settings (PRD §4.2, correction C-1).
 *
 * Settings live in `AppSetting` as key/value JSON rather than as columns, so
 * adding one is not a migration.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * businessDayStartHour — THE reporting-day boundary, and it is GLOBAL.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The business day starts at this hour, not midnight, so a session running
 * past midnight belongs to the day it started (§4.2).
 *
 * It is deliberately ONE value for the whole business, not per-branch. Two
 * reasons, and the second is the one that bites:
 *
 *   1. `WorkSession` is uniquely keyed on (userId, businessDate), but the
 *      business date must be known BEFORE the user picks a shop. A per-shop
 *      hour makes that circular for a multi-shop user (C-1).
 *
 *   2. Daily reporting groups by businessDate (§4.2). If two branches used
 *      different hours, a combined revenue report would be adding up two
 *      different definitions of "a day" — wrong in a way nobody would spot,
 *      because the total still looks plausible.
 *
 * Set to 4am (owner decision, 4 Aug 2026). The cutoff's only job is to sit in
 * a dead hour when no branch is trading, so no shift is ever cut in half. Every
 * branch closes before midnight, so 4am clears the late edge comfortably and
 * leaves margin before any early-morning setup. It is NOT related to opening
 * hours — those are per-branch and live in `Shift` (§4.14).
 *
 * NOTE: changing this later does not restamp existing rows. `businessDate` is
 * written once, when a record is created. A change creates a seam in the data,
 * so it is a policy decision, not a tuning knob.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/server/auth/context";
import { forbidden } from "@/server/errors";
import { writeAudit } from "@/server/audit";
import { DEFAULT_CUSTOMER_WHATSAPP_REMINDER_TEMPLATE } from "@/lib/customer-whatsapp";

export const BUSINESS_DAY_START_HOUR_KEY = "businessDayStartHour";
export const TICKET_AWARD_REASON_THRESHOLD_KEY =
  "ticketAwardReasonThreshold";
export const CUSTOMER_WHATSAPP_REMINDER_TEMPLATE_KEY =
  "customerWhatsAppReminderTemplate";

/** Used when the row is missing — a fresh database before the seed runs. */
export const DEFAULT_BUSINESS_DAY_START_HOUR = 4;
export const DEFAULT_TICKET_AWARD_REASON_THRESHOLD = 500;

export const updateTicketAwardReasonThresholdSchema = z.object({
  threshold: z.number().int().min(1).max(10_000_000),
});

export const updateBusinessDayStartHourSchema = z.object({
  hour: z.number().int().min(0).max(23),
});

export const updateCustomerWhatsAppReminderTemplateSchema = z.object({
  template: z.string().trim().min(1).max(1_000),
});

/**
 * Read the global business-day start hour.
 *
 * Falls back to the default rather than throwing: a missing setting must never
 * be able to stop the shop recording a sale. A wrong-by-an-hour filing date is
 * recoverable; a till that refuses to open is not.
 */
export async function getBusinessDayStartHour(): Promise<number> {
  const row = await prisma.appSetting.findUnique({
    where: { key: BUSINESS_DAY_START_HOUR_KEY },
  });

  return coerceHour(row?.value);
}

/**
 * Ticket awards above this value require a reason (§4.6). The setting is
 * global because the fraud control must mean the same thing at every branch.
 */
export async function getTicketAwardReasonThreshold(): Promise<number> {
  const row = await prisma.appSetting.findUnique({
    where: { key: TICKET_AWARD_REASON_THRESHOLD_KEY },
  });

  const n =
    typeof row?.value === "number" ? row.value : Number(row?.value);
  return Number.isInteger(n) && n >= 1
    ? n
    : DEFAULT_TICKET_AWARD_REASON_THRESHOLD;
}

/**
 * The saved text is a draft template, never an automated WhatsApp send.
 * Unknown placeholder-like text is kept as written so an owner can include
 * normal braces in their copy; only the three documented placeholders expand.
 */
export async function getCustomerWhatsAppReminderTemplate(): Promise<string> {
  const row = await prisma.appSetting.findUnique({
    where: { key: CUSTOMER_WHATSAPP_REMINDER_TEMPLATE_KEY },
  });

  return typeof row?.value === "string" && row.value.trim()
    ? row.value
    : DEFAULT_CUSTOMER_WHATSAPP_REMINDER_TEMPLATE;
}

export async function updateTicketAwardReasonThreshold(
  actor: Actor,
  threshold: number,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
): Promise<{ threshold: number }> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can change the ticket-award threshold.");
  }
  const before = await tx.appSetting.findUnique({
    where: { key: TICKET_AWARD_REASON_THRESHOLD_KEY },
  });
  const previous =
    typeof before?.value === "number"
      ? before.value
      : DEFAULT_TICKET_AWARD_REASON_THRESHOLD;

  await tx.appSetting.upsert({
    where: { key: TICKET_AWARD_REASON_THRESHOLD_KEY },
    update: { value: threshold },
    create: { key: TICKET_AWARD_REASON_THRESHOLD_KEY, value: threshold },
  });
  await writeAudit(
    actor,
    {
      entity: "AppSetting",
      entityId: TICKET_AWARD_REASON_THRESHOLD_KEY,
      action: "UPDATE",
      before: { threshold: previous },
      after: { threshold },
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );
  return { threshold };
}

export async function updateCustomerWhatsAppReminderTemplate(
  actor: Actor,
  template: string,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
): Promise<{ template: string }> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can change the WhatsApp reminder.");
  }

  const before = await tx.appSetting.findUnique({
    where: { key: CUSTOMER_WHATSAPP_REMINDER_TEMPLATE_KEY },
  });
  const previous =
    typeof before?.value === "string" && before.value.trim()
      ? before.value
      : DEFAULT_CUSTOMER_WHATSAPP_REMINDER_TEMPLATE;

  await tx.appSetting.upsert({
    where: { key: CUSTOMER_WHATSAPP_REMINDER_TEMPLATE_KEY },
    update: { value: template },
    create: { key: CUSTOMER_WHATSAPP_REMINDER_TEMPLATE_KEY, value: template },
  });
  await writeAudit(
    actor,
    {
      entity: "AppSetting",
      entityId: CUSTOMER_WHATSAPP_REMINDER_TEMPLATE_KEY,
      action: "UPDATE",
      before: { template: previous },
      after: { template },
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  return { template };
}

/**
 * Change the global business-day cutoff (§8.10, §4.2).
 *
 * **This is a policy decision, not a tuning knob, and the UI says so.**
 * `businessDate` is stamped once when a record is created and is NEVER
 * recalculated (D-18). Changing the hour therefore puts a seam in the data:
 * records either side of the change are filed by different rules, and no
 * report will ever tell you which is which.
 *
 * The change is audit-logged with both values so that seam is at least
 * explicable later — "revenue for the 9th looks odd" has an answer if someone
 * moved the cutoff on the 9th.
 *
 * Deliberately NOT offered: a "restamp history" option. Recomputing
 * `businessDate` across existing sales, ledgers, attendance and expenses would
 * silently rewrite every historical report the owner has already read.
 */
export async function updateBusinessDayStartHour(
  actor: Actor,
  hour: number,
  tx: Prisma.TransactionClient,
  meta: { ipAddress?: string | null } = {}
): Promise<{ hour: number }> {
  if (!actor.isOwner) {
    throw forbidden("Only the owner can change the business-day start hour.");
  }

  const before = await tx.appSetting.findUnique({
    where: { key: BUSINESS_DAY_START_HOUR_KEY },
  });
  const previous = coerceHour(before?.value);

  await tx.appSetting.upsert({
    where: { key: BUSINESS_DAY_START_HOUR_KEY },
    update: { value: hour },
    create: { key: BUSINESS_DAY_START_HOUR_KEY, value: hour },
  });
  await writeAudit(
    actor,
    {
      entity: "AppSetting",
      entityId: BUSINESS_DAY_START_HOUR_KEY,
      action: "UPDATE",
      before: { hour: previous },
      after: { hour },
      ipAddress: meta.ipAddress ?? null,
    },
    tx
  );

  return { hour };
}

/**
 * Validate whatever came out of the JSON column.
 *
 * The value is JSON, so it could be anything if edited by hand in the database.
 * An out-of-range hour would silently misfile every record created after it,
 * so it is rejected in favour of the default.
 */
function coerceHour(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(n) || n < 0 || n > 23) {
    return DEFAULT_BUSINESS_DAY_START_HOUR;
  }

  return n;
}
