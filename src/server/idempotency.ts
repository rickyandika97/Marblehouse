/**
 * Idempotency keys (PRD NF-5, R-3).
 *
 *   "Every mutation endpoint is idempotent against double-tap: the client sends
 *    a UUID `Idempotency-Key`, the server stores it for 24 h and returns the
 *    original result on replay. THIS MATTERS — staff will double-tap on a laggy
 *    connection and you will get duplicate sales."
 *
 * The whole mechanism rests on one thing: the INSERT of the key and the work it
 * protects must commit together. If the key were written first and the sale
 * second, a crash between them would burn the key and lose the sale; if the
 * sale were written first, a crash would produce the duplicate this exists to
 * prevent. So `runIdempotent` puts both inside ONE transaction and lets the
 * primary key on `IdempotencyKey.key` be the arbiter — the database, not
 * application logic, decides who won a race.
 *
 * Decision (Phase 2): a key that is replayed with a DIFFERENT user or endpoint
 * is a 409, never a silent pass-through. A colliding key must never be able to
 * hand one user another user's sale, and must never quietly record nothing when
 * the caller believed it was recording something.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AppError } from "@/server/errors";
import type { Actor } from "@/server/auth/context";

/** Postgres unique-violation. The race signal we actively rely on. */
const UNIQUE_VIOLATION = "P2002";

/**
 * Replay window. The PRD says 24 hours; the nightly session-cleanup job (§11)
 * deletes rows older than this.
 */
export const IDEMPOTENCY_TTL_HOURS = 24;

/**
 * A UUID, per NF-5. Kept deliberately loose on version/variant bits — the point
 * is a key wide enough not to collide by accident, not RFC conformance. We do
 * reject obviously unsafe input (empty, or long enough to be an attack on the
 * index).
 */
export function parseIdempotencyKey(req: Request): string | null {
  const raw = req.headers.get("idempotency-key")?.trim();
  if (!raw) return null;

  if (raw.length < 8 || raw.length > 200) {
    throw new AppError(
      "VALIDATION_FAILED",
      "The request's idempotency key is not a valid key.",
      { fields: { "Idempotency-Key": "Must be a UUID." } }
    );
  }

  return raw;
}

/**
 * Run `work` at most once for a given key.
 *
 * On first call: runs the work and stores its response, atomically.
 * On replay: returns the stored response WITHOUT running the work again.
 * On a key belonging to another user or endpoint: throws CONFLICT.
 *
 * When no key is supplied the work runs unprotected — the endpoint still
 * functions, it simply has no double-tap guarantee. We do not invent a key
 * server-side: two genuinely separate sales of Rp 50.000 by the same staff
 * member a second apart are legitimate and must both be recorded, so there is
 * no request property we could safely hash into a key.
 */
export async function runIdempotent<T>(
  actor: Actor,
  key: string | null,
  endpoint: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  if (!key) {
    return prisma.$transaction((tx) => work(tx));
  }

  const existing = await prisma.idempotencyKey.findUnique({ where: { key } });
  if (existing) return replay<T>(existing, actor, endpoint);

  try {
    return await prisma.$transaction(async (tx) => {
      const result = await work(tx);

      // Inside the SAME transaction as the work. If this insert loses a race it
      // throws P2002 and the work above is rolled back with it — which is
      // exactly the double-tap case, and why no duplicate can survive.
      await tx.idempotencyKey.create({
        data: {
          key,
          userId: actor.userId,
          endpoint,
          responseJson: result as Prisma.InputJsonValue,
        },
      });

      return result;
    });
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === UNIQUE_VIOLATION
    ) {
      // The other tap got there first and has now committed. Return its result,
      // which is what the caller wanted: one sale, one response.
      const winner = await prisma.idempotencyKey.findUnique({ where: { key } });
      if (winner) return replay<T>(winner, actor, endpoint);
    }
    throw e;
  }
}

/**
 * Return a stored response, after checking the key belongs to this caller.
 *
 * The ownership check is the security half of idempotency: without it, guessing
 * a key would disclose someone else's sale.
 */
function replay<T>(
  record: { userId: string; endpoint: string; responseJson: Prisma.JsonValue },
  actor: Actor,
  endpoint: string
): T {
  if (record.userId !== actor.userId || record.endpoint !== endpoint) {
    throw new AppError(
      "CONFLICT",
      "That request key has already been used for a different request. Start again with a new one."
    );
  }

  return record.responseJson as T;
}
