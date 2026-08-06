/**
 * Standard error envelope (PRD §7).
 *
 *   { "error": { "code": "...", "message": "...", "details": {} } }
 *
 * Messages are read by shop staff, not developers. Say what happened and what
 * to do about it. Never leak a stack trace, a SQL string or a cost figure —
 * error payloads are covered by the cost-visibility rule too (§15, R-4).
 */

export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "INSUFFICIENT_TICKETS",
  "INSUFFICIENT_MARBLES",
  "INSUFFICIENT_STOCK",
  "NO_WORK_SESSION",
  "ALREADY_CLOCKED_IN",
  "CATEGORY_IN_USE",
  "DUPLICATE_PHONE",
  "SALE_NOT_VOIDABLE",
  "RATE_LIMITED",
  "PASSWORD_CHANGE_REQUIRED",
  "CONFLICT",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 422,
  INSUFFICIENT_TICKETS: 409,
  INSUFFICIENT_MARBLES: 409,
  INSUFFICIENT_STOCK: 409,
  NO_WORK_SESSION: 409,
  ALREADY_CLOCKED_IN: 409,
  CATEGORY_IN_USE: 409,
  DUPLICATE_PHONE: 409,
  SALE_NOT_VOIDABLE: 409,
  RATE_LIMITED: 429,
  PASSWORD_CHANGE_REQUIRED: 403,
  CONFLICT: 409,
  INTERNAL: 500,
};

/**
 * Thrown by services. Route handlers convert it via `toErrorResponse`; nothing
 * else in a handler should be building error JSON by hand.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

export const unauthenticated = (m = "Please log in to continue.") =>
  new AppError("UNAUTHENTICATED", m);

export const forbidden = (m = "You do not have access to this.") =>
  new AppError("FORBIDDEN", m);

export const notFound = (m = "Not found.") => new AppError("NOT_FOUND", m);

export function errorBody(e: AppError) {
  return {
    error: { code: e.code, message: e.message, details: e.details },
  };
}
