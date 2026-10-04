export class HttpError extends Error {
  constructor(status, message, code, extra) {
    super(message);
    this.status = status;
    this.code = code || (status === 400 ? 'BAD_REQUEST' : status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'ERROR');
    this.extra = extra;
  }
}
export const bad = (msg, code, extra) => new HttpError(400, msg, code, extra);
export const notFound = (msg = 'ไม่พบข้อมูล') => new HttpError(404, msg);
export const forbidden = (msg = 'ไม่มีสิทธิ์ทำรายการนี้', code = 'FORBIDDEN', extra) => new HttpError(403, msg, code, extra);
export const conflict = (msg, code = 'CONFLICT', extra) => new HttpError(409, msg, code, extra);

/** Validate with a zod schema and throw a readable 400. */
export function parse(schema, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw bad(`ข้อมูลไม่ถูกต้อง: ${issue.path.join('.') || 'input'} — ${issue.message}`, 'VALIDATION', { issues: r.error.issues });
}
