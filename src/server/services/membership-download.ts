import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import QRCode from "qrcode";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Actor } from "@/server/auth/context";
import { AppError, forbidden, notFound } from "@/server/errors";
import { writeAudit } from "@/server/audit";
import { assertCustomerProfileAccess, membershipCardData } from "./membership";

export const DOWNLOAD_TTL_MS = 10 * 60 * 1000;
const payloadSchema = z
  .object({
    v: z.literal(1),
    c: z.string().min(1).max(128),
    k: z.string().length(43),
    e: z.number().int().positive(),
    u: z.string().min(1).max(128),
    n: z.string().length(16),
  })
  .strict();
export type DownloadGrant = z.infer<typeof payloadSchema>;
export const readMembershipDownloadSchema = z.object({
  token: z
    .string()
    .max(2048)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/),
});
const invalidLink = () =>
  notFound(
    "Link tidak berlaku atau sudah kedaluwarsa. Minta QR download baru kepada staf.",
  );
const version = (value: string) =>
  createHash("sha256").update(value).digest("base64url");
function signature(encoded: string): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new AppError(
      "INTERNAL",
      "Customer card downloads are not configured. Ask the owner for help.",
    );
  return createHmac("sha256", secret)
    .update(`membership-download:v1:${encoded}`)
    .digest();
}
export function membershipDownloadOrigin(): string {
  try {
    const url = new URL(
      process.env.MEMBERSHIP_DOWNLOAD_ORIGIN || process.env.APP_URL || "",
    );
    if (
      url.protocol !== "https:" ||
      !url.hostname.includes(".") ||
      url.hostname === "127.0.0.1" ||
      url.hostname.endsWith(".localhost") ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.origin;
  } catch {
    throw new AppError(
      "VALIDATION_FAILED",
      "Set MEMBERSHIP_DOWNLOAD_ORIGIN to the public HTTPS website before creating a customer download QR.",
    );
  }
}

/** Only unsigned metadata enters the idempotency table; the bearer link is never stored. */
export async function createMembershipDownload(
  actor: Actor,
  id: string,
  tx: Prisma.TransactionClient,
): Promise<DownloadGrant> {
  membershipDownloadOrigin();
  signature(""); // Fail before writing an audit if the signing key is missing.
  await assertCustomerProfileAccess(actor, id, tx);
  const customer = await tx.customer.findUnique({ where: { id } });
  if (!customer || !customer.isActive || customer.mergedIntoId)
    throw notFound();
  const grant: DownloadGrant = {
    v: 1,
    c: id,
    k: version(customer.membershipToken),
    e: Date.now() + DOWNLOAD_TTL_MS,
    u: actor.userId,
    n: randomBytes(12).toString("base64url"),
  };
  await writeAudit(
    actor,
    {
      entity: "Customer",
      entityId: id,
      action: "CREATE_MEMBERSHIP_DOWNLOAD",
      after: { expiresAt: new Date(grant.e).toISOString() },
    },
    tx,
  );
  return grant;
}

/** Replay also rechecks current access, expiry, issuer and card version before signing. */
export async function presentMembershipDownload(
  actor: Actor,
  raw: DownloadGrant,
  tx: Prisma.TransactionClient = prisma,
) {
  const grant = payloadSchema.parse(raw);
  await assertCustomerProfileAccess(actor, grant.c, tx);
  if (grant.u !== actor.userId) throw forbidden();
  if (grant.e <= Date.now()) throw invalidLink();
  const customer = await tx.customer.findUnique({ where: { id: grant.c } });
  if (
    !customer ||
    !customer.isActive ||
    customer.mergedIntoId ||
    version(customer.membershipToken) !== grant.k
  )
    throw invalidLink();
  const encoded = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const token = `${encoded}.${signature(encoded).toString("base64url")}`;
  const url = `${membershipDownloadOrigin()}/membership/download#${token}`;
  const qr = await QRCode.toDataURL(url, {
    // Whole-pixel modules avoid fractional scaling artifacts in the link QR.
    scale: 8,
    margin: 4,
    errorCorrectionLevel: "M",
  });
  return { qr, expiresAt: new Date(grant.e).toISOString() };
}

/** Public, narrowly scoped capability access: no staff Actor and no arbitrary customer lookup. */
export async function readMembershipDownload(
  token: string,
  tx: Prisma.TransactionClient = prisma,
) {
  if (!readMembershipDownloadSchema.shape.token.safeParse(token).success)
    throw invalidLink();
  const [encoded, supplied] = token.split(".") as [string, string];
  const expected = signature(encoded);
  const actual = Buffer.from(supplied, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw invalidLink();
  let grant: DownloadGrant;
  try {
    grant = payloadSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
  } catch {
    throw invalidLink();
  }
  if (grant.e <= Date.now() || grant.e > Date.now() + DOWNLOAD_TTL_MS)
    throw invalidLink();
  const [customer, issuer] = await Promise.all([
    tx.customer.findUnique({ where: { id: grant.c } }),
    tx.user.findUnique({ where: { id: grant.u }, select: { banned: true } }),
  ]);
  if (
    !issuer ||
    issuer.banned ||
    !customer ||
    !customer.isActive ||
    customer.mergedIntoId ||
    version(customer.membershipToken) !== grant.k
  )
    throw invalidLink();
  return membershipCardData(customer);
}
