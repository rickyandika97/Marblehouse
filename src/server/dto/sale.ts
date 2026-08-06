/**
 * Sale response shapes (PRD §7.2, §8.2).
 *
 * A sale carries no cost field — Phase 2 has no COGS anywhere — so there is one
 * builder here, not the two-builder split that §7.5 requires for prizes and
 * stock. What IS role-shaped is which sales you may see at all, and that is
 * enforced in the service's query, not by trimming a response.
 *
 * `amount` crosses the wire as a STRING. Prisma's Decimal must never be handed
 * to JSON.stringify as a number: 14-digit rupiah values are already close to
 * the point where a double stops being exact, and §4.1 forbids float money.
 */
import type {
  PaymentMethod,
  Sale,
  SaleStatus,
  Customer,
  SalePreset,
  User,
} from "@prisma/client";

export interface SaleDTO {
  id: string;
  amount: string;
  paymentMethod: PaymentMethod;
  status: SaleStatus;
  isCustomAmount: boolean;
  note: string | null;

  shopId: string;
  businessDate: string;
  occurredAt: string;

  preset: { id: string; label: string } | null;
  /** Null means walk-in (§4.4) — the UI must label it, not leave it blank. */
  customer: { id: string; name: string; phoneDisplay: string } | null;
  recordedBy: { id: string; displayName: string };

  voidedAt: string | null;
  voidReason: string | null;
}

type SaleWithRelations = Sale & {
  preset: SalePreset | null;
  customer: Pick<Customer, "id" | "name" | "phoneNormalized"> | null;
  recordedBy: Pick<User, "id" | "displayName">;
};

export function toSaleDTO(
  s: SaleWithRelations,
  formatPhone: (normalized: string) => string
): SaleDTO {
  return {
    id: s.id,
    // .toString() on Decimal is exact. Number() would not be.
    amount: s.amount.toString(),
    paymentMethod: s.paymentMethod,
    status: s.status,
    isCustomAmount: s.isCustomAmount,
    note: s.note,

    shopId: s.shopId,
    businessDate: s.businessDate.toISOString().slice(0, 10),
    occurredAt: s.occurredAt.toISOString(),

    preset: s.preset ? { id: s.preset.id, label: s.preset.label } : null,
    customer: s.customer
      ? {
          id: s.customer.id,
          name: s.customer.name,
          phoneDisplay: formatPhone(s.customer.phoneNormalized),
        }
      : null,
    recordedBy: { id: s.recordedBy.id, displayName: s.recordedBy.displayName },

    voidedAt: s.voidedAt?.toISOString() ?? null,
    voidReason: s.voidReason,
  };
}
