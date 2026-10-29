export type ErrorCode =
  'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'locked' |
  'too_many_requests';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  locked: 423,
  too_many_requests: 429,
};

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  get status(): number {
    return STATUS[this.code];
  }
}

export const notFound = (what: string) => new AppError('not_found', `${what} not found`);
export const forbidden = (msg: string) => new AppError('forbidden', msg);
export const badRequest = (msg: string, details?: Record<string, unknown>) =>
  new AppError('bad_request', msg, details);

/** Translate Postgres unique-violation into a readable conflict. */
export function mapPgError(err: unknown): unknown {
  const e = err as { code?: string; constraint?: string; detail?: string } | null | undefined;
  if (e?.code === '23505') {
    return new AppError('conflict', `Already exists (${e.constraint ?? 'unique'})`, {
      detail: e.detail,
    });
  }
  if (e?.code === '23514') {
    return new AppError('bad_request', `Invalid value (${e.constraint ?? 'check'})`);
  }
  if (e?.code === '22P02') {
    return new AppError('bad_request', 'Malformed identifier');
  }
  return err;
}
