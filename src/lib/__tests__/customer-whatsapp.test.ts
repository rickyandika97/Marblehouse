import { describe, expect, it } from "vitest";
import {
  customerWhatsAppUrl,
  renderCustomerWhatsAppReminder,
} from "../customer-whatsapp";

describe("customer WhatsApp reminder", () => {
  const customer = {
    name: "Budi",
    marbleBalance: 12_500,
    ticketBalance: 250,
  };

  it("fills every supported placeholder with the current balance", () => {
    expect(
      renderCustomerWhatsAppReminder(
        "Hi {name}: {marbles} marbles, {tickets} tickets.",
        customer
      )
    ).toBe("Hi Budi: 12.500 marbles, 250 tickets.");
  });

  it("opens a WhatsApp draft for the normalised international phone number", () => {
    expect(customerWhatsAppUrl("+62812-3456-789", "Hello Budi!")).toBe(
      "https://wa.me/628123456789?text=Hello%20Budi!"
    );
  });
});
