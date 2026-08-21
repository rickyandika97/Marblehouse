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

/**
 * Digits to look for in a partial phone search.
 *
 * Records are stored with the country code (`+62812…`), while staff normally
 * begin a lookup with the local form (`0812…`). Keep the raw digits too so a
 * partial subscriber number such as `3456` still works, then add the
 * country-code spelling only when the query explicitly starts as a local or
 * international number. Prefixing every short fragment would make `812` mean
 * something different from the digits the staff actually entered.
 */
export function phoneSearchCandidates(
  input: string,
  countryCode = DEFAULT_COUNTRY_CODE
): string[] {
  const digits = input.replace(/\D/g, "");
  if (!digits) return [];

  const candidates = new Set([digits]);
  let canonical = digits;

  if (canonical.startsWith("00")) canonical = canonical.slice(2);
  if (canonical.startsWith("0")) canonical = countryCode + canonical.slice(1);

  candidates.add(canonical);
  return [...candidates];
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
