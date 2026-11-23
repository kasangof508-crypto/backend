import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: 'Validation failed', details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...err.extra });
  if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Duplicate value: record already exists' });
  if (err?.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'Referenced record does not exist' });
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal server error' });
}

export const parse = (schema, data) => schema.parse(data);
