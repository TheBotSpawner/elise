/**
 * ELISE error taxonomy (docs/engineering/18-observability-errors-audit.md §13).
 * Providers translate their own failures into these codes; the rest of the app never
 * depends on raw provider errors.
 */
export const ERROR_CODES = [
  "AUTH_ERROR",
  "AUTH_EXPIRED",
  "PERMISSION_DENIED",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "CAPABILITY_UNAVAILABLE",
  /**
   * This server (or background worker) lacks a secret or setting it needs — never the user's
   * connection. Kept apart from CAPABILITY_UNAVAILABLE so it's never shown as "not connected".
   */
  "SERVER_NOT_CONFIGURED",
  "TIMEOUT",
  "AI_PROVIDER_ERROR",
  "AI_NOT_CONFIGURED",
  "BACKGROUND_ERROR",
  "UNKNOWN_OUTCOME",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** What the user can do to recover. Mapped to buttons/copy by the UI. */
export type RecoveryAction = "retry" | "reconnect" | "review" | "configure" | "sign_in" | "none";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "AI_PROVIDER_ERROR",
]);

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly recovery: RecoveryAction;
  /** Short reference users can share with support. Never contains internal details. */
  readonly referenceId: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options: { recovery?: RecoveryAction; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.recovery = options.recovery ?? (this.retryable ? "retry" : "none");
    this.details = options.details;
    this.referenceId = `ERR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError("INTERNAL_ERROR", "Unexpected error", { cause: error });
}

/** Serializable shape safe to send to the browser or the model. */
export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  recovery: RecoveryAction;
  referenceId: string;
}

export function toPublicError(error: unknown): PublicError {
  const e = toAppError(error);
  return {
    code: e.code,
    // Internal errors never leak their message.
    message: e.code === "INTERNAL_ERROR" ? "Unexpected error" : e.message,
    retryable: e.retryable,
    recovery: e.recovery,
    referenceId: e.referenceId,
  };
}
