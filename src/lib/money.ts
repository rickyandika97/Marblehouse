/**
 * Money helpers (PRD §4.1).
 *
 * RULE: money is Prisma Decimal in the database and a string or Decimal in
 * transit. NEVER do arithmetic on money with JavaScript numbers — 0.1 + 0.2
 * is not 0.3, and a rounding error in a sales total is very hard to find later.
 *
 * IDR is effectively whole-rupiah, so we display with no decimals and
 * thousand separators: 50000 → "Rp 50.000".
 */

export const CURRENCY = "IDR";
export const LOCALE = "id-ID";

type MoneyLike = string | number | { toString(): string };

/**
 * The separator between "Rp" and the digits, written out explicitly.
 *
 * DO NOT go back to `style: "currency"` here. Engines disagree on what sits
 * between the symbol and the number for id-ID: Node/V8 emits U+00A0 (an
 * NBSP, "Rp 20.000") while Safari/JavaScriptCore emits nothing at all
 * ("Rp20.000"). Server and client then render different text for the same
 * number and React tears the tree down with a hydration error — which is
 * exactly what the sale preset tiles did in Safari.
 *
 * Only the grouping separator is left to Intl, because every engine agrees
 * id-ID groups with "." — it is the currency *spacing* that is unportable.
 *
 * NBSP rather than a plain space so a price never wraps between "Rp" and its
 * amount.
 */
const CURRENCY_SPACE = " ";

export function formatMoney(value: MoneyLike): string {
  const n = Number(value.toString());
  if (!Number.isFinite(n)) return "—";
  // Sign goes OUTSIDE the symbol — "-Rp 5.000", which is what `style:
  // "currency"` produced and what a net-profit loss should still read as.
  // Formatting the absolute value keeps the "-" from landing between "Rp"
  // and the digits.
  const sign = n < 0 ? "-" : "";
  return `${sign}Rp${CURRENCY_SPACE}${formatAmount(Math.abs(n))}`;
}

/** 50000 → "50.000" (no currency symbol; for tight table cells). */
export function formatAmount(value: MoneyLike): string {
  const n = Number(value.toString());
  if (!Number.isFinite(n)) return "—";
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(n);
}

/** "Rp 50.000" / "50000" / "50.000" → 50000. Returns null if unparseable. */
export function parseAmount(input: string): number | null {
  const digits = input.replace(/[^\d]/g, "");
  if (digits === "") return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}
