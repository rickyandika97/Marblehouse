import { handleRoute, clientIp } from "@/server/http";
import { requireWorkSession } from "@/server/auth/guards";
import { AppError } from "@/server/errors";
import { clockIn, clockInSchema } from "@/server/services/attendance";

/**
 * Clock in (§4.13, §7.7). `multipart/form-data` — the photo is a blob.
 *
 * The shop comes from the work session, never the request body, exactly as a
 * sale does. Not idempotency-keyed: the unique constraint on
 * `(userId, businessDate)` already makes a double-tap safe, and it returns a
 * friendly conflict rather than a duplicate record.
 */
export async function POST(req: Request) {
  return handleRoute(async () => {
    const actor = await requireWorkSession();

    const form = await req.formData().catch(() => null);
    if (!form) {
      throw new AppError("VALIDATION_FAILED", "Send the photo as form data.");
    }

    const photo = form.get("photo");
    if (!(photo instanceof Blob) || photo.size === 0) {
      throw new AppError("VALIDATION_FAILED", "A photo is required to clock in.");
    }

    const input = clockInSchema.parse({
      shiftId: form.get("shiftId") ?? undefined,
      latitude: form.get("latitude") ?? undefined,
      longitude: form.get("longitude") ?? undefined,
      accuracyM: form.get("accuracyM") ?? undefined,
      locationDenied: form.get("locationDenied") ?? false,
    });

    return clockIn(actor, actor.workSession.shopId, await photo.arrayBuffer(), input, {
      ipAddress: clientIp(req),
    });
  });
}
