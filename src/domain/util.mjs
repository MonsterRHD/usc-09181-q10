import crypto from 'node:crypto';

/** 单调时钟 + 调用方提供偏移（跨时区客户端），仍按 UTC 存储。 */
export function nowIso() {
  return new Date().toISOString();
}

/** 把任意 ISO 字符串/Date 规范化为毫秒时间戳，非法值抛错。 */
export function toMs(value, field = '时间字段') {
  if (value instanceof Date) return value.getTime();
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`${field} 不是合法 ISO 时间: ${String(value)}`);
  return t;
}

export function hashJson(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** 对象键排序后的稳定 JSON，用于指纹与审计链。 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortValue(value[key]);
        return acc;
      }, {});
  }
  return value;
}

export function sha256Chain(prevHash, payload) {
  return crypto.createHash('sha256').update(`${prevHash}\n${canonicalJson(payload)}`).digest('hex');
}

let counter = 0;
/** 时间前缀 + 随机后缀的可读 ID，单进程内不重复。 */
export function id(prefix) {
  counter = (counter + 1) % 0xffff;
  const rand = crypto.randomBytes(5).toString('hex');
  return `${prefix}_${Date.now().toString(36)}${counter.toString(16).padStart(2, '0')}${rand}`;
}

export function clone(value) {
  return structuredClone(value);
}
