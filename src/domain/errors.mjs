/** 领域内统一的错误类型，HTTP 层据此映射状态码。 */
export class DomainError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const invalid = (code, message, details) => new DomainError(400, code, message, details);
export const notFound = (code, message, details) => new DomainError(404, code, message, details);
export const conflict = (code, message, details) => new DomainError(409, code, message, details);
export const unprocessable = (code, message, details) => new DomainError(422, code, message, details);

export function required(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) throw invalid('MISSING_FIELDS', `缺少必填字段: ${missing.join(', ')}`, { missing });
}
