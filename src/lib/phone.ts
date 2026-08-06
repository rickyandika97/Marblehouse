/**
 * Phone normalisation (PRD §4.4).
 *
 * The phone number is the customer's identity key — it is what lets marble
 * and ticket balances follow them between branches. Store BOTH the raw input
 * (so staff recognise it) and the normalised form (unique, used for lookup).
 *
 * These must all collapse to the same key:
 *   0812-3456-789   +62 812 3456 789   628123456789   0812 3456 789
 */

const DEFAULT_COUNTRY_CODE = "62"; // Indonesia

export function normalizePhone(input: string, countryCode = DEFAULT_COUNTRY_CODE): string {
  let digits = input.replace(/\D/g, "");

  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = countryCode + digits.slice(1);
  else if (!digits.startsWith(countryCode)) digits = countryCode + digits;

  return "+" + digits;
}

export function isPlausiblePhone(input: string): boolean {
  const digits = normalizePhone(input).replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

/** "+628123456789" → "0812-3456-789" for display. */
export function formatPhoneLocal(normalized: string, countryCode = DEFAULT_COUNTRY_CODE): string {
  const digits = normalized.replace(/\D/g, "");
  const local = digits.startsWith(countryCode) ? "0" + digits.slice(countryCode.length) : digits;
  return local.replace(/(\d{4})(\d{4})(\d+)/, "$1-$2-$3");
}
