/**
 * The clock-in route's form parsing (§4.13, §4.14.1).
 *
 * The service tests in `src/server/services/__tests__/attendance.test.ts` prove
 * the cover gate itself, on both branches. They cannot prove that the FIELDS
 * the browser sends actually reach the service — they call `clockIn` directly.
 * That gap hid a real defect: the route read `shiftId`, the coordinates and
 * `locationDenied` out of the form but never `coverReason`, so someone covering
 * an unrostered shift typed a reason on the first screen, sent it, and was
 * still refused with "say who you are covering for" (D-149).
 *
 * So this tests one thing only, at the layer where that bug lived: every field
 * the client puts in the FormData arrives in the parsed input. The guard and
 * the service are mocked — the shop still comes from the work session, never
 * the body, and asserting that here would only re-test the guard.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { Actor } from "@/server/auth/context";

const clockIn = vi.fn();
const requireWorkSession = vi.fn();

vi.mock("@/server/auth/guards", () => ({ requireWorkSession }));
vi.mock("@/server/services/attendance", async () => {
  // The real schema, so a field the route forwards under the wrong name fails
  // here exactly as it would in production.
  const actual = await vi.importActual<
    typeof import("@/server/services/attendance")
  >("@/server/services/attendance");
  return { clockIn, clockInSchema: actual.clockInSchema };
});

const { POST } = await import("./route");

const SHOP_ID = "shop_test";

/** Only the fields this route touches; the rest of `Actor` is irrelevant here. */
function actor() {
  return {
    userId: "user_test",
    workSession: { shopId: SHOP_ID },
  } as unknown as Actor & { workSession: NonNullable<Actor["workSession"]> };
}

function request(fields: Record<string, string>) {
  const form = new FormData();
  form.append("photo", new Blob([new Uint8Array([1, 2, 3])]), "clock-in.jpg");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request("http://localhost/api/attendance/clock-in", {
    method: "POST",
    body: form,
  });
}

/** The `input` argument the route handed the service. */
function inputPassedToService() {
  return clockIn.mock.calls[0]?.[3];
}

beforeEach(() => {
  vi.clearAllMocks();
  requireWorkSession.mockResolvedValue(actor());
  clockIn.mockResolvedValue({ id: "att_test", photoUrl: "/x", isLate: false });
});

describe("POST /api/attendance/clock-in — form fields reach the service", () => {
  it("forwards the cover reason", async () => {
    const response = await POST(
      request({
        shiftId: "shift_1",
        coverReason: "Covering for Budi, he is sick",
        locationDenied: "true",
      })
    );

    expect(response.status).toBe(200);
    expect(inputPassedToService()).toMatchObject({
      shiftId: "shift_1",
      coverReason: "Covering for Budi, he is sick",
    });
  });

  it("forwards the shift and the location fields", async () => {
    await POST(
      request({
        shiftId: "shift_1",
        latitude: "-6.2",
        longitude: "106.8",
        accuracyM: "12",
        locationDenied: "false",
      })
    );

    expect(inputPassedToService()).toMatchObject({
      shiftId: "shift_1",
      latitude: -6.2,
      longitude: 106.8,
      accuracyM: 12,
      locationDenied: false,
    });
  });

  it("leaves the cover reason undefined when the client sends none", async () => {
    // The scheduled case, which is the common one. A reason must not be
    // invented here — the service stores it only on a COVER row, and an empty
    // string would fail the schema's `min(3)` for a staff member who is simply
    // on the roster.
    await POST(request({ shiftId: "shift_1", locationDenied: "true" }));

    expect(inputPassedToService()?.coverReason).toBeUndefined();
  });

  it("rejects a request with no photo", async () => {
    const form = new FormData();
    form.append("coverReason", "Covering for Budi");
    const response = await POST(
      new Request("http://localhost/api/attendance/clock-in", {
        method: "POST",
        body: form,
      })
    );

    expect(response.status).toBe(422); // VALIDATION_FAILED, per src/server/errors.ts
    expect(clockIn).not.toHaveBeenCalled();
  });
});
