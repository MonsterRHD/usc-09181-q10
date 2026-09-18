import { sha256Chain, nowIso } from './util.mjs';

/**
 * 追加式审计日志，哈希链：每条记录 hash = sha256(prevHash + 规范化载荷)。
 * 任何篡改都会让后续链校验失败。时间统一存 UTC ISO。
 */
export function appendAudit(state, { actor = 'system', action, entityId = null, details = {} }) {
  const seq = ++state.counters.auditSeq;
  const prevHash = state.auditTailHash;
  const record = {
    seq,
    ts: nowIso(),
    actor,
    action,
    entityId,
    details,
    prevHash,
  };
  record.hash = sha256Chain(prevHash, { seq, ts: record.ts, actor, action, entityId, details });
  state.audit.push(record);
  state.auditTailHash = record.hash;
  return record;
}

/** 从头重放哈希链，返回首个断裂位置；完好时返回 null。 */
export function verifyAuditChain(state) {
  let prev = 'GENESIS';
  for (const rec of state.audit) {
    if (rec.prevHash !== prev) return { seq: rec.seq, reason: 'prevHash 不衔接' };
    const payload = { seq: rec.seq, ts: rec.ts, actor: rec.actor, action: rec.action, entityId: rec.entityId, details: rec.details };
    const expect = sha256Chain(prev, payload);
    if (expect !== rec.hash) return { seq: rec.seq, reason: '哈希不匹配，记录可能被篡改' };
    prev = rec.hash;
  }
  if (state.auditTailHash !== prev) return { reason: '尾哈希与链不一致' };
  return null;
}

export function auditTimeline(state, { entityId = null, since = null, limit = 500 } = {}) {
  let rows = state.audit;
  if (entityId) rows = rows.filter((r) => r.entityId === entityId);
  if (since) rows = rows.filter((r) => r.ts >= since);
  return rows.slice(-limit).map(({ seq, ts, actor, action, entityId: eid, details }) => ({
    seq, ts, actor, action, entityId: eid, details,
  }));
}
