/**
 * Phone normalisation (PRD §15, §4.4).
 *
 * §15 names this case:
 *
 *   "Phone normalisation: `0812...`, `+62812...`, `62812...`, and formats
 *    with spaces and dashes all collapse to one key."
 *
 * Why this matters more than it looks: the normalised phone is the customer's
 * IDENTITY KEY. It is what lets a marble balance follow someone from one
 * branch to another (§4.5). If two spellings of one number produce two keys,
 * the customer gets two records and their balance splits in half — and the
 * staff member who typed the second spelling has no way to see that happened.
 *
 * Pure-function tests, no database.
 */
import { describe, expect, it } from "vitest";
import {
  formatPhoneLocal,
  isPlausiblePhone,
  normalizePhone,
  phoneSearchCandidates,
} from "../phone";

/** The canonical form every spelling below must collapse to. */
const KEY = "+628123456789";

describe("§15: every spelling collapses to one key", () => {
  // The four forms §15 names, plus the punctuation staff actually type.
  const spellings = [
    ["local leading zero", "08123456789"],
    ["E.164 with plus", "+628123456789"],
    ["country code, no plus", "628123456789"],
    ["local, dashed", "0812-3456-789"],
    ["local, spaced", "0812 3456 789"],
    ["E.164, spaced", "+62 812 3456 789"],
    ["E.164, dashed", "+62-812-3456-789"],
    ["parenthesised area", "(0812) 3456 789"],
    ["dotted", "0812.3456.789"],
    ["international 00 prefix", "00628123456789"],
    ["mixed punctuation and spaces", " +62 (812) 3456-789 "],
  ] as const;

  for (const [label, input] of spellings) {
    it(`${label}: ${input}`, () => {
      expect(normalizePhone(input)).toBe(KEY);
    });
  }

  it("all of them produce exactly ONE distinct key", () => {
    // The assertion that actually encodes the requirement. Each case above
    // could pass individually while some pair still disagreed if the expected
    // value were ever loosened, so collapse the whole set and count it.
    const keys = new Set(spellings.map(([, input]) => normalizePhone(input)));

    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(KEY);
  });
});

describe("distinct numbers stay distinct", () => {
  // The opposite failure: a normaliser that over-collapses would MERGE two
  // real customers, which is worse than splitting one.
  it("two different subscribers get different keys", () => {
    expect(normalizePhone("0812-3456-789")).not.toBe(normalizePhone("0812-3456-780"));
  });

  it("a trailing digit is not lost", () => {
    expect(normalizePhone("08123456789")).not.toBe(normalizePhone("081234567890"));
  });

  it("does not confuse a leading 0 with a country code digit", () => {
    // 0812… is local (→ +62812…); 62812… is already prefixed. Both are the
    // same subscriber. But 812… without either must not silently become a
    // different subscriber — it gets the country code prepended.
    expect(normalizePhone("8123456789")).toBe(KEY);
  });
});

describe("the output shape", () => {
  it("always starts with a plus and holds digits only", () => {
    for (const input of ["08123456789", "+62 812 3456 789", "628123456789"]) {
      const key = normalizePhone(input);
      expect(key.startsWith("+")).toBe(true);
      expect(key.slice(1)).toMatch(/^\d+$/);
    }
  });

  it("is idempotent — normalising a key again returns the same key", () => {
    // Load-bearing: a normalised value gets re-normalised whenever a record is
    // edited and saved. A second pass that changed it would orphan the row.
    expect(normalizePhone(KEY)).toBe(KEY);
    expect(normalizePhone(normalizePhone(normalizePhone("0812-3456-789")))).toBe(KEY);
  });

  it("honours a non-default country code", () => {
    // Never used in v1 (Indonesia only), but the parameter exists and a wrong
    // default here would be invisible until the day a second country is added.
    expect(normalizePhone("0812-3456-789", "60")).toBe("+608123456789");
  });
});

describe("plausibility", () => {
  it("accepts a real Indonesian mobile", () => {
    expect(isPlausiblePhone("0812-3456-789")).toBe(true);
    expect(isPlausiblePhone("081234567890")).toBe(true);
  });

  it("rejects a number that is too short", () => {
    expect(isPlausiblePhone("0812")).toBe(false);
  });

  it("rejects a number that is too long", () => {
    expect(isPlausiblePhone("0812345678901234567")).toBe(false);
  });

  it("checks the length AFTER normalising, not before", () => {
    // "0812 3456 789" is 13 characters but 12 digits, and normalises to 12
    // digits + country code. A pre-normalisation length check would count the
    // spaces and reject a valid number.
    expect(isPlausiblePhone("0812 3456 789")).toBe(true);
  });
});

describe("display formatting", () => {
  it("renders a key back into the local form staff recognise", () => {
    expect(formatPhoneLocal(KEY)).toBe("0812-3456-789");
  });

  it("round-trips: display form normalises back to the same key", () => {
    // §4.4 stores both the raw input and the key. This is what keeps the
    // displayed value and the lookup value describing one customer.
    expect(normalizePhone(formatPhoneLocal(KEY))).toBe(KEY);
  });
});

describe("phone search candidates", () => {
  it("finds a country-code record from the local digits staff type", () => {
    const candidates = phoneSearchCandidates("0812-3456");

    expect(candidates).toContain("08123456");
    expect(candidates).toContain("628123456");
    expect(candidates.some((term) => KEY.includes(term))).toBe(true);
  });

  it("keeps a subscriber-number fragment literal", () => {
    expect(phoneSearchCandidates("3456")).toEqual(["3456"]);
  });
});
