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

describe("landingPathFor (§8.0)", () => {
  it("sends an OWNER to the dashboard", () => {
    expect(landingPathFor("OWNER")).toBe("/dashboard");
  });

  it("sends a MANAGER to the sale screen", () => {
    // A manager CAN reach /dashboard, but /sale is the working screen they
    // want after signing in or clocking in.
    expect(landingPathFor("MANAGER")).toBe("/sale");
  });

  it("NEVER sends a STAFF member to the dashboard", () => {
    // The one that matters: /dashboard is `requireManagerOrOwnerPage`, so this
    // returning "/dashboard" is a guaranteed 403 for staff.
    expect(landingPathFor("STAFF")).toBe("/sale");
    expect(landingPathFor("STAFF")).not.toBe("/dashboard");
  });

  it("defaults an unknown role to the safe screen, not the dashboard", () => {
    // Defensive: a role that is not OWNER must never fall through to a page
    // it cannot open.
    expect(landingPathFor("SOMETHING_NEW")).toBe("/sale");
  });
});
