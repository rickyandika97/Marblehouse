/**
 * Route-handler plumbing.
 *
 * CLAUDE.md: "Route handlers do three things only: authenticate, validate with
 * Zod, call a service." This file owns the fourth thing — turning whatever
 * comes back into a response — so no handler has to.
 */
import { NextResponse } from "next/server";
import { ZodError, type ZodTypeAny, type output } from "zod";
import { AppError, errorBody } from "@/server/errors";

/** Client IP for audit rows. Behind the tunnel, trust CF-Connecting-IP (§12.2). */
export function clientIp(req: Request): string | null {
  const trustProxy = process.env.TRUST_PROXY === "true";
  const h = req.headers;

  if (trustProxy) {
    const cf = h.get("cf-connecting-ip");
    if (cf) return cf;
    const fwd = h.get("x-forwarded-for");
    if (fwd) return fwd.split(",")[0]?.trim() ?? null;
  }

  return h.get("x-real-ip");
}

export function userAgent(req: Request): string | null {
  return req.headers.get("user-agent")?.slice(0, 500) ?? null;
}

/**
 * Parse and validate a JSON body.
 *
 * Throws AppError(VALIDATION_FAILED) with per-field messages, so the client
 * can show them inline rather than a single opaque "invalid input".
 */
/**
 * Typed to the schema's OUTPUT, so `.default()` and other transforms are
 * reflected: a field with a default is optional to the caller but guaranteed
 * present to the service.
 */
export async function parseJson<S extends ZodTypeAny>(
  req: Request,
  schema: S
): Promise<output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError("VALIDATION_FAILED", "Expected a JSON body.");
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new AppError(
      "VALIDATION_FAILED",
      "Some of the details you entered are not valid.",
      { fields: fieldErrors(result.error) }
    );
  }

  return result.data;
}

function fieldErrors(error: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    out[key] ??= issue.message;
  }
  return out;
}

/**
 * Wrap a route handler: converts AppError into the standard envelope and
 * anything unexpected into a 500 that says nothing useful to an attacker.
 */
export function handleRoute<T>(
  fn: () => Promise<T>
): Promise<NextResponse> {
  return fn()
    .then((data) =>
      data === undefined
        ? new NextResponse(null, { status: 204 })
        : NextResponse.json(data)
    )
    .catch((e: unknown) => {
      if (e instanceof AppError) {
        return NextResponse.json(errorBody(e), { status: e.status });
      }

      if (e instanceof ZodError) {
        const wrapped = new AppError(
          "VALIDATION_FAILED",
          "Some of the details you entered are not valid.",
          { fields: fieldErrors(e) }
        );
        return NextResponse.json(errorBody(wrapped), { status: wrapped.status });
      }

      console.error("[route] unhandled error:", e);
      const internal = new AppError(
        "INTERNAL",
        "Something went wrong. Try again, and tell the owner if it keeps happening."
      );
      return NextResponse.json(errorBody(internal), { status: 500 });
    });
}
