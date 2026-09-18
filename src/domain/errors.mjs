export class DomainError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export const ERR = {
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION: 'VALIDATION',
  UNKNOWN_REQUIREMENT: 'UNKNOWN_REQUIREMENT',
  PREREQUISITES_NOT_MET: 'PREREQUISITES_NOT_MET',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  DUPLICATE: 'DUPLICATE',
};
