export class AppError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
  }
}

export function requireCondition(condition: unknown, status: number, code: string, message: string): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}

export function publicError(error: unknown): { status: number; code: string; message: string; details?: unknown } {
  if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message, details: error.details };
  return { status: 500, code: 'internal_error', message: 'The operation failed. Check the service logs using the request ID.' };
}
