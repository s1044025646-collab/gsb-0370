export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'SEQ_CONFLICT'
  | 'TRADE_ID_CONFLICT'
  | 'OVERSOLD'
  | 'LEDGER_NOT_FOUND'
  | 'VERSION_NOT_FOUND'
  | 'BAD_REQUEST'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown): AppError {
  return new AppError('BAD_REQUEST', message, details);
}
