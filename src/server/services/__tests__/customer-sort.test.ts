/**
 * Customer list ordering (§8.5, D-174).
 *
 * The point of these is that ranking by balance is a question about EVERY
 * customer, not about whichever page happens to be loaded. A browser-side sort
 * of the 50-row page would pass a naive "is it descending?" check while still
 * hiding the actual biggest holder behind whoever visited most recently, so the
 * fixtures below deliberately make the top holder the LEAST recent customer.
 *
 * `searchCustomers` uses the module-level Prisma client, so these cannot run
 * inside `withRollback`'s transaction client — they write real rows and clean
 * up in `afterEach`, following `attendance.test.ts`.
 */
import { describe, expect, it, afterEach, afterAll } from "vitest";
import { prisma, uniq, makeActor } from "./helpers";
import { searchCustomers } from "../customers";

const customerIds: string[] = [];

afterEach(async () => {
  await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
  customerIds.length = 0;
});

afterAll(async () => {
  await prisma.$disconnect();
});

/**
 * Three customers whose balance order is the exact REVERSE of their recency
 * order. Any implementation that quietly falls back to "recent" therefore
 * returns them backwards rather than coincidentally right.
 */
async function fixture() {
  // Letters only: `searchCustomers` routes a query with three or more digits
  // to the phone branch, so a tag like "a1b2c3d4" would never reach the name
  // match these tests rely on.
  const tag = uniq().replace(/[^a-z]/gi, "") + "zz";
  /**
   * Three orderings that are mutually distinct, so no assertion below can pass
   * by coincidence: recency is low→mid→top, marbles is top→mid→low, and tickets
   * is mid→top→low — deliberately matching NEITHER of the other two. An earlier
   * fixture had tickets agreeing with recency, and the ticket case then stayed
   * green while the sort was deliberately broken.
   */
  const spec = [
    { suffix: "top", marbles: 900, tickets: 500, daysAgo: 30 },
    { suffix: "mid", marbles: 500, tickets: 900, daysAgo: 20 },
    { suffix: "low", marbles: 100, tickets: 10, daysAgo: 1 },
  ];

  const made: Record<string, string> = {};
  for (const [i, s] of spec.entries()) {
    const lastSeenAt = new Date(Date.now() - s.daysAgo * 86_400_000);
    // Unique per row and per run; the phone column is unique-constrained.
    // The digits come from a fresh UUID rather than a clock, which repeats
    // inside a single loop.
    const phone = `0899${uniq().replace(/\D/g, "")}${i}${Date.now() % 100000}`;
    const row = await prisma.customer.create({
      data: {
        name: `Sort ${tag} ${s.suffix}`,
        phoneRaw: phone,
        phoneNormalized: phone,
        marbleBalance: s.marbles,
        ticketBalance: s.tickets,
        lastSeenAt,
      },
      select: { id: true },
    });
    customerIds.push(row.id);
    made[s.suffix] = row.id;
  }
  return { tag, made };
}

/** Only this fixture's rows, in the order the service returned them. */
function ordered(customers: { id: string }[], made: Record<string, string>) {
  const byId = new Map(Object.entries(made).map(([k, v]) => [v, k]));
  return customers.map((c) => byId.get(c.id)).filter(Boolean);
}

describe("customer list ordering (§8.5)", () => {
  const actor = makeActor({ role: "OWNER" });

  it("ranks the biggest marble holders first, across all customers", async () => {
    const { tag, made } = await fixture();

    const { customers } = await searchCustomers(actor, {
      q: `Sort ${tag}`,
      sort: "marbles",
    });

    expect(ordered(customers, made)).toEqual(["top", "mid", "low"]);
  });

  it("ranks the biggest ticket holders first", async () => {
    const { tag, made } = await fixture();

    const { customers } = await searchCustomers(actor, {
      q: `Sort ${tag}`,
      sort: "tickets",
    });

    // Matches neither the marble order nor the recency order, so this cannot
    // pass by falling back to either.
    expect(ordered(customers, made)).toEqual(["mid", "top", "low"]);
  });

  it("still defaults to most-recent, which is the counter case", async () => {
    const { tag, made } = await fixture();

    const { customers } = await searchCustomers(actor, { q: `Sort ${tag}` });

    expect(ordered(customers, made)).toEqual(["low", "mid", "top"]);
  });

  it("sorts by balance rather than by whoever was seen most recently", async () => {
    const { tag, made } = await fixture();

    const byMarbles = await searchCustomers(actor, {
      q: `Sort ${tag}`,
      sort: "marbles",
    });
    const byTickets = await searchCustomers(actor, {
      q: `Sort ${tag}`,
      sort: "tickets",
    });
    const byRecent = await searchCustomers(actor, { q: `Sort ${tag}` });

    // The guard that matters: the fixture's top marble holder is its LEAST
    // recent customer, so these orderings must not agree. If a refactor ever
    // drops the sort and falls back to `recent`, this is what catches it —
    // checked for BOTH balance orders, since one passing says nothing about
    // the other (D-34).
    expect(ordered(byMarbles.customers, made)).not.toEqual(
      ordered(byRecent.customers, made)
    );
    expect(ordered(byTickets.customers, made)).not.toEqual(
      ordered(byRecent.customers, made)
    );
    expect(ordered(byMarbles.customers, made)).not.toEqual(
      ordered(byTickets.customers, made)
    );
    expect(ordered(byMarbles.customers, made)[0]).toBe("top");
    expect(ordered(byTickets.customers, made)[0]).toBe("mid");
  });
});
