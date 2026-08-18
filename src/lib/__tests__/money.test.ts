/**
 * Money formatting (PRD §4.1) — and the hydration defect behind it.
 *
 * `formatMoney` used to be `Intl.NumberFormat(style: "currency")`. That is
 * NOT portable for id-ID: engines disagree about what separates the symbol
 * from the digits.
 *
 *   Node / V8              → "Rp 20.000"  (U+00A0, a non-breaking space)
 *   Safari / JavaScriptCore → "Rp20.000"        (no separator at all)
 *
 * Because the sale preset tiles are server-rendered and then hydrated, the
 * server sent "Rp 20.000" and Safari rendered "Rp20.000" — different text for
 * the same number, so React threw "server rendered text didn't match the
 * client" and tore the tree down. It reproduced only in Safari; Chrome shares
 * V8's ICU with the server and agreed with it, which is what made this hard
 * to find.
 *
 * The separator is now written out explicitly, so these assertions are the
 * real contract: they compare against literal escapes rather than against
 * `Intl` output, because asserting one ICU build against another ICU build
 * would pass in CI and still break in Safari.
 *
 * Pure-function tests, no database.
 */
import { describe, expect, it } from "vitest";
import { formatAmount, formatMoney, parseAmount } from "../money";

/** U+00A0. Written as an escape so the byte cannot be lost to an editor. */
const NBSP = " ";

describe("§4.1: formatMoney is engine-independent", () => {
  it("separates symbol and digits with exactly one U+00A0", () => {
    const s = formatMoney(20000);
    expect(s).toBe(`Rp${NBSP}20.000`);
    expect([...s].map((c) => c.codePointAt(0))).toEqual([
      0x52, 0x70, 0x00a0, 0x32, 0x30, 0x2e, 0x30, 0x30, 0x30,
    ]);
  });

  it("never emits a plain space, which would let a price wrap after 'Rp'", () => {
    expect(formatMoney(50000)).not.toContain(" ");
  });

  it("never emits the Safari form with no separator", () => {
    // The exact string Safari produced, and the reason the tree was regenerated.
    expect(formatMoney(20000)).not.toBe("Rp20.000");
  });

  it("groups thousands with '.' per id-ID", () => {
    expect(formatMoney(1234567)).toBe(`Rp${NBSP}1.234.567`);
    expect(formatMoney(999)).toBe(`Rp${NBSP}999`);
  });

  it("renders whole rupiah — IDR has no minor unit in this product", () => {
    expect(formatMoney("20000.00")).toBe(`Rp${NBSP}20.000`);
    expect(formatMoney(0.6)).toBe(`Rp${NBSP}1`);
  });
});

describe("§4.1: sign placement", () => {
  it("puts the minus OUTSIDE the symbol, as a loss should read", () => {
    // Net profit (§9) can legitimately be negative. The sign must not land
    // between "Rp" and the digits.
    expect(formatMoney(-5000)).toBe(`-Rp${NBSP}5.000`);
    expect(formatMoney(-1234567)).toBe(`-Rp${NBSP}1.234.567`);
  });

  it("never renders a negative zero", () => {
    // ICU's currency style produced "-Rp 0" here, which is nonsense on a
    // report line. A zero total reads as zero.
    expect(formatMoney(-0)).toBe(`Rp${NBSP}0`);
    expect(formatMoney(0)).toBe(`Rp${NBSP}0`);
  });
});

describe("§4.1: non-numeric input", () => {
  it("returns an em dash rather than NaN", () => {
    expect(formatMoney("abc")).toBe("—");
    expect(formatMoney(Infinity)).toBe("—");
  });
});

describe("§4.1: formatAmount carries no symbol", () => {
  it("groups but does not prefix", () => {
    expect(formatAmount(50000)).toBe("50.000");
    expect(formatAmount(1234567)).toBe("1.234.567");
  });
});

describe("§4.1: parseAmount round-trips what formatMoney renders", () => {
  it("reads back a formatted price, NBSP and all", () => {
    // The sale form parses typed amounts; a value that was rendered by us
    // must survive being read back, or a re-edit silently changes the price.
    for (const n of [0, 999, 20000, 50000, 1234567]) {
      expect(parseAmount(formatMoney(n))).toBe(n);
    }
  });
});
