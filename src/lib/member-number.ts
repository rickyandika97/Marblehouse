/** Stable display ID printed on membership cards; never a QR credential. */
export function memberNumber(customerId: string): string {
  return customerId.slice(-8).toUpperCase();
}
