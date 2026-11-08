import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma, uniq, makeActor } from "./helpers";
import { searchCustomers } from "../customers";

const customerIds: string[] = [];
const actor = makeActor({ role: "STAFF" });

afterEach(async () => {
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  customerIds.length = 0;
});
afterAll(async () => prisma.$disconnect());

async function customer(suffix = "f865pquc", extra = {}) {
  const id = `search-${uniq()}-${suffix}`;
  const phone = `test-${uniq().replace(/[2-9]/g, "x")}`;
  customerIds.push(id);
  return prisma.customer.create({
    data: {
      id,
      name: `Search ${uniq()}`,
      phoneRaw: phone,
      phoneNormalized: phone,
      ...extra,
    },
  });
}

describe("customer member ID search", () => {
  it.each(["F865PQUC", "f865pquc", "  F865pQuC  "])(
    "finds the card's member number with query %s",
    async (q) => {
      const row = await customer();
      const { customers } = await searchCustomers(actor, { q });
      expect(customers.map((c) => c.id)).toContain(row.id);
      expect(customers.find((c) => c.id === row.id)).not.toHaveProperty(
        "membershipToken",
      );
    },
  );

  it.each(["abcdefgh", "12345678"])("also matches member ID %s", async (suffix) => {
    const row = await customer(suffix);
    const { customers } = await searchCustomers(actor, { q: suffix });
    expect(customers.map((c) => c.id)).toContain(row.id);
  });

  it("matches the end of the customer ID, not an internal fragment", async () => {
    const row = await customer("f865pquc-extra");
    const { customers } = await searchCustomers(actor, { q: "F865PQUC" });
    expect(customers.map((c) => c.id)).not.toContain(row.id);
  });

  it("does not confuse digits inside a member ID with phone digits", async () => {
    const match = await customer();
    const other = await customer("otherzzz", {
      phoneNormalized: `+62865${Date.now()}`,
    });
    const { customers } = await searchCustomers(actor, { q: "F865PQUC" });
    expect(customers.map((c) => c.id)).toContain(match.id);
    expect(customers.map((c) => c.id)).not.toContain(other.id);
  });

  it("keeps inactive and merged customers out of member ID results", async () => {
    const winner = await customer("winnerzz");
    const inactive = await customer("f865pquc", { isActive: false });
    const merged = await customer("f865pquc", { mergedIntoId: winner.id });
    const { customers } = await searchCustomers(actor, { q: "F865PQUC" });
    expect(customers.map((c) => c.id)).not.toContain(inactive.id);
    expect(customers.map((c) => c.id)).not.toContain(merged.id);
  });

  it("preserves name and normalized local-phone searches", async () => {
    const row = await customer("phonezzz", {
      name: `Search 865 ${uniq().replace(/[^a-z]/g, "")} zzz`,
      phoneRaw: "0812-3456-7890",
      phoneNormalized: `+6281234567890${Date.now()}`,
    });
    for (const q of [row.name, "0812-3456", "+62 812 3456", "34567890"]) {
      const { customers } = await searchCustomers(actor, { q });
      expect(customers.map((c) => c.id)).toContain(row.id);
    }
  });
});
