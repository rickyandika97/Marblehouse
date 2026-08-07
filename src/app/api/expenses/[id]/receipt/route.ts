import { readFile } from "node:fs/promises";
import { handleRoute } from "@/server/http";
import { requireSettledActor } from "@/server/auth/guards";
import { attachReceipt, getReceiptPath } from "@/server/services/expenses";
import { resolveReceiptPath, storeReceipt } from "@/server/services/receipts";
import { AppError, notFound } from "@/server/errors";

/**
 * The receipt image (§4.12, §7.6).
 *
 * Served ONLY through this authenticated route, never as a static path — the
 * same rule §4.15 sets for attendance photos, and for the same reason: a
 * static URL is a permanent public link to a document that names a supplier,
 * an amount and a date.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;

    const relativePath = await getReceiptPath(actor, id);

    let bytes: Buffer;
    try {
      bytes = await readFile(resolveReceiptPath(relativePath));
    } catch {
      throw notFound("That receipt is no longer on disk.");
    }

    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, max-age=300",
        "Content-Length": String(bytes.byteLength),
      },
    });
  });
}

/**
 * Upload a receipt for an existing expense.
 *
 * Separate from expense creation on purpose: the expense is the money record
 * and must land even if the photo fails. Making the image part of the create
 * would mean a flaky upload on shop wifi loses the expense too.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return handleRoute(async () => {
    const actor = await requireSettledActor();
    const { id } = await params;

    const form = await req.formData().catch(() => null);
    const file = form?.get("receipt");
    if (!(file instanceof File)) {
      throw new AppError("VALIDATION_FAILED", "Attach a receipt image.");
    }

    const { relativePath } = await storeReceipt(await file.arrayBuffer());
    return attachReceipt(actor, id, relativePath);
  });
}
