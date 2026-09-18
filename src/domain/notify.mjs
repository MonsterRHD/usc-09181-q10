import { id, nowIso } from './util.mjs';
import { appendAudit } from './audit.mjs';
import { affectedEnrollments, getEntity } from './entities.mjs';

/**
 * 通知只针对“受影响实体”：新版本材料结构变化、材料过期等。
 * 通知按实体去重（同一实体同一版本同一变更类型只入队一次），可标记送达。
 */
export function notifyRuleChange(state, rulebook, actor = 'system') {
  const affected = affectedEnrollments(state, rulebook);
  const byEntity = new Map();
  for (const item of affected) {
    const entityId = item.enrollment.entityId;
    if (!byEntity.has(entityId)) byEntity.set(entityId, { entityId, activities: [] });
    byEntity.get(entityId).activities.push({
      activityKey: item.enrollment.activityKey,
      fromVersion: item.fromVersion,
      changes: item.changes,
    });
  }

  const notifications = [];
  for (const { entityId, activities } of byEntity.values()) {
    const dedupeKey = `rulebook:${rulebook.version}:${entityId}`;
    if (state.notifications.some((n) => n.dedupeKey === dedupeKey)) continue;
    const entity = getEntity(state, entityId);
    const n = {
      id: id('ntf'),
      dedupeKey,
      entityId,
      kind: 'rulebook.published',
      payload: {
        countryCode: entity.countryCode,
        version: rulebook.version,
        effectiveFrom: rulebook.effectiveFrom,
        note: rulebook.note,
        activities,
      },
      status: 'queued',
      createdAt: nowIso(),
      deliveredAt: null,
    };
    state.notifications.push(n);
    notifications.push(n);
  }
  appendAudit(state, {
    actor,
    action: 'notification.rulechange',
    details: { version: rulebook.version, entityCount: notifications.length, entityIds: notifications.map((n) => n.entityId) },
  });
  return notifications;
}

export function markDelivered(state, notificationId) {
  const n = state.notifications.find((x) => x.id === notificationId);
  if (!n) return null;
  if (n.status === 'queued') {
    n.status = 'delivered';
    n.deliveredAt = nowIso();
  }
  return n;
}

export function pendingNotifications(state, entityId = null) {
  return state.notifications.filter((n) => n.status === 'queued' && (!entityId || n.entityId === entityId));
}

/**
 * 材料过期通知：按 (实体, 活动, 材料, 证据) 去重，同一份过期证据只通知一次。
 * 在批量重算/重启续跑时调用，差异（哪份证据何时过期）随载荷留痕。
 */
export function notifyExpiredMaterials(state, evaluations, actor = 'system') {
  const notifications = [];
  for (const ev of evaluations) {
    for (const act of ev.activities) {
      for (const m of act.materials) {
        if (m.state !== 'expired' || !m.evidence) continue;
        const materialKey = `${act.activityKey}.${m.materialKey}`;
        const dedupeKey = `expiry:${ev.entityId}:${materialKey}:${m.evidence.id}`;
        if (state.notifications.some((n) => n.dedupeKey === dedupeKey)) continue;
        const n = {
          id: id('ntf'),
          dedupeKey,
          entityId: ev.entityId,
          kind: 'material.expired',
          payload: {
            materialKey,
            ownerRole: m.ownerRole,
            evidenceId: m.evidence.id,
            source: m.evidence.source,
            documentRef: m.evidence.documentRef,
            expiresAt: m.evidence.expiresAt,
            reason: m.blockReason,
          },
          status: 'queued',
          createdAt: nowIso(),
          deliveredAt: null,
        };
        state.notifications.push(n);
        notifications.push(n);
      }
    }
  }
  if (notifications.length) {
    appendAudit(state, {
      actor,
      action: 'notification.expiry',
      details: { count: notifications.length, keys: notifications.map((n) => n.dedupeKey) },
    });
  }
  return notifications;
}
