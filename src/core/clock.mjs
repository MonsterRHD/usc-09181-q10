/** 时间一律以 UTC 时刻存储（ISO-8601 带 Z），跨时区协作只比较同一时刻。 */

export function toIso(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(d.getTime())) throw new TypeError(`无效时间: ${instant}`);
  return d.toISOString();
}

export function isPast(instant, now) {
  if (instant === null || instant === undefined) return false;
  return new Date(instant).getTime() <= toDate(now).getTime();
}

export function toDate(now) {
  return now instanceof Date ? now : new Date(now);
}
