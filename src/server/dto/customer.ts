/**
 * Customer response shapes (PRD §3.4, §8.5, §7.5).
 *
 * Two builders, deliberately separate:
 *
 *   toCustomerDTO()      name, phone, marble balance, ticket balance.
 *                        Every role sees this. It is what staff need at the
 *                        counter and nothing more.
 *
 *   toCustomerOwnerDTO() the above plus spend, visit history, preferred shop
 *                        and active days — OWNER ONLY (§3.4).
 *
 * The restricted builder PHYSICALLY DOES NOT READ the owner-only fields. Per
 * §7.5 this must never be implemented by deleting keys from a full object: a
 * later refactor reintroduces the leak silently, and nobody notices because the
 * shape still looks right in a test.
 *
 * The same rule that protects COGS in Phase 4 protects customer analytics here.
 * Managers and staff are explicitly limited to "name, phone, marbles, tickets"
 * by requirement 9.1.
 */
import type { Customer } from "@prisma/client";
import { formatPhoneLocal } from "@/lib/phone";

/** What a STAFF or MANAGER session may see. */
export interface CustomerDTO {
  id: string;
  name: string;
  phone: string;
  phoneDisplay: string;
  note: string | null;
  marbleBalance: number;
  ticketBalance: number;
  isActive: boolean;
}

/** Owner-only analytics, additive on top of CustomerDTO (§8.5). */
export interface CustomerOwnerDTO extends CustomerDTO {
  totalSpend: string;
  saleCount: number;
  averageSpend: string;
  firstSeenAt: string;
  lastSeenAt: string;
  activeDays: number;
  preferredShop: { id: string; name: string } | null;
}

/**
 * The restricted builder.
 *
 * Note what is absent: no spend, no visit counts, no preferred shop. Those are
 * not "hidden" here — they are never read from the row in the first place.
 */
export function toCustomerDTO(c: Customer): CustomerDTO {
  return {
    id: c.id,
    name: c.name,
    phone: c.phoneNormalized,
    phoneDisplay: formatPhoneLocal(c.phoneNormalized),
    note: c.note,
    marbleBalance: c.marbleBalance,
    ticketBalance: c.ticketBalance,
    isActive: c.isActive,
  };
}

/** Aggregates computed in SQL by the service — never derived in JavaScript. */
export interface CustomerStats {
  totalSpend: string;
  saleCount: number;
  activeDays: number;
  preferredShop: { id: string; name: string } | null;
}

/**
 * The owner builder.
 *
 * Takes the stats explicitly rather than reaching for them, so that a caller
 * cannot accidentally produce this shape without having gone through the
 * owner-gated query path.
 */
export function toCustomerOwnerDTO(
  c: Customer,
  stats: CustomerStats
): CustomerOwnerDTO {
  const spend = Number(stats.totalSpend);
  const average = stats.saleCount > 0 ? spend / stats.saleCount : 0;

  return {
    ...toCustomerDTO(c),
    totalSpend: stats.totalSpend,
    saleCount: stats.saleCount,
    // Display-only average. Money arithmetic that matters is done in SQL /
    // Decimal (§4.1); this value is never stored or summed.
    averageSpend: average.toFixed(2),
    firstSeenAt: c.firstSeenAt.toISOString(),
    lastSeenAt: c.lastSeenAt.toISOString(),
    activeDays: stats.activeDays,
    preferredShop: stats.preferredShop,
  };
}
