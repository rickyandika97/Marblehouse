/**
 * Where each role lands (§8.0; BUILD-LOG D-113).
 *
 * A pure-function test, but it earns its place: `/dashboard` is
 * MANAGER-or-OWNER only, so any code that sends a STAFF member there produces
 * a 403 on a screen they reached by doing the right thing. That is exactly the
 * bug the owner hit — two buttons in the clock-in flow were hardcoded to
 * `/dashboard`, so finishing a clock-in as STAFF landed on "You do not have
 * access to this page".
 *
 * The rule lives in ONE function. This pins it, and pins the reason.
 */
import { describe, expect, it } from "vitest";
import { landingPathFor } from "../auth";

describe("landingPathFor (§8.0, D-122)", () => {
  it("sends an OWNER to the dashboard", () => {
    expect(landingPathFor(true)).toBe("/dashboard");
  });

  it("NEVER sends a non-owner to the dashboard", () => {
    // The one that matters: /dashboard is `requireManagerOrOwnerPage`, so
    // this returning "/dashboard" for a non-owner is a guaranteed 403 —
    // whether they are STAFF everywhere, MANAGER somewhere, or a mix of
    // both (D-122: role is per-shop, so "non-owner" is the only distinction
    // this function can make; a MANAGER still lands on /sale, same as
    // before, and can navigate to /dashboard themselves).
    expect(landingPathFor(false)).toBe("/sale");
    expect(landingPathFor(false)).not.toBe("/dashboard");
  });
});
