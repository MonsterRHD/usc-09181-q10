import crypto from 'node:crypto';

/** 稳定序列化：对象键排序后输出，保证同内容哈希可复现（重复导入判定用）。 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function contentHash(payload) {
  return sha256(stableStringify(payload));
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
