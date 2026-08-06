/**
 * The cost-leak gate (PRD §7.5, §15 permission tests).
 *
 * §16 accepts Phase 4 only when "a plain manager session provably cannot see a
 * cost value anywhere". §7.5 specifies how to prove it: serialize the response
 * and assert the forbidden strings are absent — not that some field is
 * undefined, because a nested object or a future field would slip past that.
 *
 * These are DTO-level. The HTTP-level proof, with real sessions against a
 * running server, is `scripts/verify-phase4.sh`.
 */
import { describe, expect, test } from "vitest";
import { Prisma, type PrizeBatch, type PrizeItem } from "@prisma/client";
import {
  toPrizeRestrictedDTO,
  toPrizeCostDTO,
  toBatchRestrictedDTO,
  toBatchCostDTO,
} from "../prize";

/** §7.5's list, plus `valuation`. Matched case-insensitively. */
const FORBIDDEN = [
  "cogs",
  "unitCost",
  "unitCogs",
  "varianceValue",
  "margin",
  "profit",
  "valuation",
];

function assertNoCostStrings(payload: unknown, label: string) {
  const json = JSON.stringify(payload).toLowerCase();
  for (const needle of FORBIDDEN) {
    expect(json, `${label} leaked "${needle}"`).not.toContain(needle.toLowerCase());
  }
}

const item: PrizeItem = {
  id: "prize_1",
  sku: "TEDDY",
  name: "Teddy Bear",
  category: "Plush",
  imagePath: null,
  ticketCost: 500,
  isActive: true,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

const batch: PrizeBatch = {
  id: "batch_1",
  shopId: "shop_1",
  prizeItemId: "prize_1",
  batchCode: "B-001",
  qtyReceived: 100,
  qtyRemaining: 40,
  unitCogs: new Prisma.Decimal("12345.67"),
  supplier: "Supplier A",
  note: null,
  isAdjustment: false,
  needsCosting: false,
  isVoid: false,
  receivedAt: new Date("2026-01-02T00:00:00Z"),
  createdAt: new Date("2026-01-02T00:00:00Z"),
  createdById: "user_1",
  sourceBatchId: null,
};

describe("restricted DTOs carry no cost", () => {
  test("a prize DTO for a plain manager contains no cost string", () => {
    const dto = toPrizeRestrictedDTO({
      item,
      shopConfig: { isActive: true, lowStockThreshold: 5 },
      onHand: 40,
    });

    assertNoCostStrings(dto, "toPrizeRestrictedDTO");
    // And it still carries what staff legitimately need.
    expect(dto.ticketCost).toBe(500);
    expect(dto.onHand).toBe(40);
  });

  test("a batch DTO for a plain manager contains no cost string", () => {
    const dto = toBatchRestrictedDTO(batch);

    assertNoCostStrings(dto, "toBatchRestrictedDTO");
    expect(dto.qtyRemaining).toBe(40);
    expect(dto.supplier).toBe("Supplier A");
  });

  test("the restricted builder cannot be handed a cost by its caller", () => {
    // The guarantee is structural, not defensive: the value below is a full
    // batch row, and the builder simply never reads its cost columns. If a
    // future refactor implemented this by deleting keys instead, this test
    // would still pass — which is why the TYPE is the real control. See the
    // narrowed source types in dto/prize.ts.
    const dto = toBatchRestrictedDTO(batch);
    expect(Object.keys(dto)).not.toContain("unitCogs");
    expect(Object.keys(dto)).not.toContain("needsCosting");
  });
});

describe("cost DTOs carry cost, as strings", () => {
  test("a prize cost DTO exposes valuation", () => {
    const dto = toPrizeCostDTO({
      item,
      shopConfig: { isActive: true, lowStockThreshold: 5 },
      onHand: 40,
      stockValuation: "493826.80",
      uncostedBatchCount: 2,
    });

    expect(dto.stockValuation).toBe("493826.80");
    expect(dto.uncostedBatchCount).toBe(2);
  });

  test("batch cost DTO reports money as strings, never JSON numbers", () => {
    const dto = toBatchCostDTO(batch);

    // D-13 / §4.1: Decimal → JSON number is the float bug the PRD forbids.
    expect(typeof dto.unitCogs).toBe("string");
    expect(typeof dto.remainingValue).toBe("string");
    expect(dto.unitCogs).toBe("12345.67");
    // 40 × 12345.67 = 493826.80 exactly. A float would give 493826.79999...
    expect(dto.remainingValue).toBe("493826.8");
  });
});

describe("low-stock flag", () => {
  const withStock = (onHand: number, lowStockThreshold: number) =>
    toPrizeRestrictedDTO({
      item,
      shopConfig: { isActive: true, lowStockThreshold },
      onHand,
    }).isLowStock;

  test("fires at or below the threshold", () => {
    expect(withStock(5, 5)).toBe(true);
    expect(withStock(4, 5)).toBe(true);
    expect(withStock(6, 5)).toBe(false);
  });

  test("threshold 0 means no alert, even at zero stock (§4.8)", () => {
    expect(withStock(0, 0)).toBe(false);
  });

  test("an unstocked item never flags", () => {
    expect(
      toPrizeRestrictedDTO({ item, shopConfig: null, onHand: 0 }).isLowStock
    ).toBe(false);
  });
});
