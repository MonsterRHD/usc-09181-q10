import { id, nowIso } from './util.mjs';
import { notFound, unprocessable } from './errors.mjs';
import { appendAudit } from './audit.mjs';
import { getEntity } from './entities.mjs';
import { evaluateEntity } from './status.mjs';
import { auditTimeline } from './audit.mjs';

/**
 * 法务开业审查：同一实体可能跨时区被多个法务并行处理
 * （A 时区补许可、撤销豁免，B 时区同时更新税务材料）。
 * 审查记录记快照与结论；“标记完成/放行签约”必须以可签约状态引擎为准，
 * 未满足前置条件时服务端拒绝完成，不依赖调用方自觉。
 */
export function openReview(state, entityId, { openedBy = 'legal', timeZone, note = '' }) {
  const entity = getEntity(state, entityId);
  const tz = timeZone || entity.timeZone;
  const snapshot = evaluateEntity(state, entityId);
  const review = {
    id: id('rev'),
    entityId,
    openedAt: nowIso(),
    openedBy,
    openedFromTimeZone: tz,
    note,
    status: 'open',
    openSnapshot: { signable: snapshot.signable, blockerCount: snapshot.blockers.length },
    closedAt: null,
    decision: null,
    checkedBlockers: [],
  };
  state.reviews.push(review);
  appendAudit(state, { actor: openedBy, action: 'review.open', entityId, details: { reviewId: review.id, timeZone: tz, note } });
  return review;
}

/** 法务逐条核对阻断理由。 */
export function checkBlocker(state, reviewId, { materialKey, confirmed = true, comment = '' }, actor = 'legal') {
  const review = getReview(state, reviewId);
  const entry = {
    materialKey,
    confirmed,
    comment,
    checkedBy: actor,
    checkedAt: nowIso(),
    fromTimeZone: review.openedFromTimeZone,
  };
  review.checkedBlockers.push(entry);
  appendAudit(state, { actor, action: 'review.blocker.checked', entityId: review.entityId, details: { reviewId, ...entry } });
  return entry;
}

/**
 * 尝试放行。服务端重新计算状态：
 * - 仍有未满足材料 → 422，返回阻断理由，审查保持 open（未满足前置条件不能标记完成）
 * - 全部满足 → 记录审查结论并把实体置为 ready_to_sign
 * at 可显式指定评估时点（默认当前 UTC），便于跨时区客户端用本地法律时点核对。
 */
export function completeReview(state, reviewId, { actor = 'legal', note = '', at } = {}) {
  const review = getReview(state, reviewId);
  if (review.status !== 'open') throw unprocessable('REVIEW_CLOSED', `审查已结束: ${reviewId}（${review.decision}）`);

  const evaluation = evaluateEntity(state, review.entityId, at);
  if (!evaluation.signable) {
    appendAudit(state, {
      actor,
      action: 'review.complete.rejected',
      entityId: review.entityId,
      details: { reviewId, blockers: evaluation.blockers },
    });
    throw unprocessable('PRECONDITIONS_UNMET', '仍有前置材料未满足，不能标记开业审查完成', {
      reviewId,
      blockers: evaluation.blockers,
    });
  }

  review.status = 'closed';
  review.decision = 'approved';
  review.closedAt = nowIso();
  review.closedBy = actor;
  review.closeNote = note;
  const entity = getEntity(state, review.entityId);
  entity.status = 'ready_to_sign';
  entity.approvedAt = review.closedAt;

  appendAudit(state, {
    actor,
    action: 'review.complete.approved',
    entityId: review.entityId,
    details: { reviewId, note, checkedBlockerCount: review.checkedBlockers.length },
  });
  return { review, evaluation };
}

export function getReview(state, reviewId) {
  const r = state.reviews.find((x) => x.id === reviewId);
  if (!r) throw notFound('REVIEW_NOT_FOUND', `审查不存在: ${reviewId}`);
  return r;
}

/** 审查视图：实时状态 + 阻断核对记录 + 审计时间线（跨时区操作均以 UTC 呈现）。 */
export function reviewBundle(state, reviewId) {
  const review = getReview(state, reviewId);
  const evaluation = evaluateEntity(state, review.entityId);
  const timeline = auditTimeline(state, { entityId: review.entityId });
  return { review, evaluation, timeline };
}
