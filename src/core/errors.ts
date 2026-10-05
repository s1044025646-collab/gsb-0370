export type ErrorCode =
  | "VALIDATION_ERROR"
  | "SEQ_CONFLICT"
  | "TXN_DUPLICATE_CONFLICT"
  | "OVERSOLD"
  | "INVALID_BATCH"
  | "NOT_FOUND"
  | "VERSION_ARCHIVED"
  | "STORAGE_ERROR";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}
