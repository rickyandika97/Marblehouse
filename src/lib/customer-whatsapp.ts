/**
 * A customer-balance reminder is deliberately composed locally: tapping the
 * shortcut opens WhatsApp with a draft, but Marblehouse never sends a message
 * on a staff member's behalf.
 */
export const DEFAULT_CUSTOMER_WHATSAPP_REMINDER_TEMPLATE =
  "Halo {name}, kamu masih punya {marbles} marbles dan {tickets} tickets di Marblehouse. Yuk, main lagi!";

export function renderCustomerWhatsAppReminder(
  template: string,
  customer: { name: string; marbleBalance: number; ticketBalance: number }
): string {
  return template
    .replaceAll("{name}", customer.name)
    .replaceAll("{marbles}", customer.marbleBalance.toLocaleString("id-ID"))
    .replaceAll("{tickets}", customer.ticketBalance.toLocaleString("id-ID"));
}

export function customerWhatsAppUrl(
  phone: string,
  message: string
): string {
  // wa.me expects an international number without the leading plus.
  const recipient = phone.replace(/\D/g, "");
  return `https://wa.me/${recipient}?text=${encodeURIComponent(message)}`;
}
