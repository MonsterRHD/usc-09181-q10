import { EVT } from './events.mjs';

/**
 * 纯函数投影：按 seq 重放事件日志得到内存状态。
 * 进程重启后重放同一日志，状态与关停前一致，人工核查记录因此可接续。
 */
export function createState() {
  return {
    countries: new Map(), // id -> {id, code, name}
    activities: new Map(), // `${countryId}:${code}` -> {code, name, countryId}
    roles: new Map(), // code -> {code, name}
    ruleVersions: new Map(), // countryId -> [版本快照...]（按 version 升序）
    entities: new Map(), // id -> {id, name, countryId, activities, version}
    evidence: new Map(), // entityId -> Map(code -> {active, history[]})
    imports: new Map(), // importId -> 首次导入结果（幂等键）
    reviews: new Map(), // entityId -> Map(code -> 评审记录)
    exemptions: new Map(), // entityId -> Map(code -> 最新豁免记录)
    notifications: new Map(), // entityId -> [通知...]
    openingReviews: new Map(), // entityId -> [开业审查记录...]
  };
}

function bumpEntityVersion(state, entityId) {
  const e = state.entities.get(entityId);
  if (e) e.version += 1;
}

function nested(map, key, ctor) {
  if (!map.has(key)) map.set(key, ctor());
  return map.get(key);
}

export function applyEvent(state, rec) {
  const { type, data } = rec;
  switch (type) {
    case EVT.COUNTRY_REGISTERED:
      state.countries.set(data.id, { id: data.id, code: data.code, name: data.name });
      break;

    case EVT.ACTIVITY_REGISTERED:
      state.activities.set(`${data.countryId}:${data.code}`, {
        countryId: data.countryId,
        code: data.code,
        name: data.name,
      });
      break;

    case EVT.ROLE_REGISTERED:
      state.roles.set(data.code, { code: data.code, name: data.name });
      break;

    case EVT.RULES_PUBLISHED: {
      const list = nested(state.ruleVersions, data.countryId, () => []);
      list.push({
        version: data.version,
        publishedAt: data.publishedAt,
        effectiveFrom: data.effectiveFrom ?? null,
        actor: data.actor,
        specs: structuredClone(data.specs),
        diff: data.diff ?? null,
      });
      break;
    }

    case EVT.ENTITY_ONBOARDED:
      state.entities.set(data.id, {
        id: data.id,
        name: data.name,
        countryId: data.countryId,
        activities: [...data.activities],
        onboardedAt: data.onboardedAt,
        version: 1,
      });
      break;

    case EVT.EVIDENCE_SUPERSEDED: {
      // 必须先于同事务的 EVIDENCE_IMPORTED 出现：把旧活动证据归档进 history。
      const slot = nested(nested(state.evidence, data.entityId, () => new Map()), data.code, () => ({
        active: null,
        history: [],
      }));
      if (slot.active && slot.active.id === data.previousEvidenceId) {
        slot.active.supersededAt = data.at;
        slot.active.supersededBy = data.by;
        slot.active.supersedeReason = data.reason ?? null;
        slot.history.push(slot.active);
        slot.active = null;
      }
      bumpEntityVersion(state, data.entityId);
      break;
    }

    case EVT.EVIDENCE_IMPORTED: {
      const slot = nested(nested(state.evidence, data.entityId, () => new Map()), data.code, () => ({
        active: null,
        history: [],
      }));
      slot.active = { ...data.evidence };
      // 幂等键映射随事件重建：重启重放后重复导入仍能识别。
      if (data.importId) state.imports.set(data.importId, { evidenceId: data.evidence.id });
      bumpEntityVersion(state, data.entityId);
      break;
    }

    case EVT.IMPORT_DEDUPLICATED:
      if (data.importId) state.imports.set(data.importId, { evidenceId: data.originalEvidenceId });
      bumpEntityVersion(state, data.entityId);
      break;

    case EVT.EXEMPTION_GRANTED:
      nested(state.exemptions, data.entityId, () => new Map()).set(data.code, {
        code: data.code,
        status: 'GRANTED',
        reason: data.reason,
        grantedBy: data.grantedBy,
        grantedAt: data.grantedAt,
        expiresAt: data.expiresAt ?? null,
        revokedBy: null,
        revokedAt: null,
      });
      bumpEntityVersion(state, data.entityId);
      break;

    case EVT.EXEMPTION_REVOKED: {
      const ex = state.exemptions.get(data.entityId)?.get(data.code);
      if (ex) {
        ex.status = 'REVOKED';
        ex.revokedBy = data.revokedBy;
        ex.revokedAt = data.revokedAt;
        ex.revokeReason = data.reason;
      }
      bumpEntityVersion(state, data.entityId);
      break;
    }

    case EVT.REQUIREMENT_REVIEWED: {
      nested(state.reviews, data.entityId, () => new Map()).set(data.code, {
        code: data.code,
        decision: data.decision,
        reviewer: data.reviewer,
        reviewedAt: data.reviewedAt,
        note: data.note ?? null,
        evidenceId: data.evidenceId ?? null,
      });
      bumpEntityVersion(state, data.entityId);
      break;
    }

    case EVT.NOTIFICATION_CREATED:
      nested(state.notifications, data.entityId, () => []).push({
        ...data.notification,
        read: false,
      });
      bumpEntityVersion(state, data.entityId);
      break;

    case EVT.NOTIFICATION_READ: {
      const note = state.notifications.get(data.entityId)?.find((n) => n.id === data.notificationId);
      if (note) note.read = true;
      break;
    }

    case EVT.OPENING_REVIEW_COMPLETED:
      nested(state.openingReviews, data.entityId, () => []).push({
        id: data.id,
        reviewer: data.reviewer,
        reviewedAt: data.reviewedAt,
        expectedVersion: data.expectedVersion,
        snapshot: structuredClone(data.snapshot),
        blockers: structuredClone(data.blockers),
        note: data.note ?? null,
        decision: data.decision,
      });
      break;

    default:
      throw new Error(`未知事件类型: ${type}`);
  }
  return state;
}

/** 从事件日志重建某实体某材料的完整证据链（按导入时间，旧到新，含被替代证据）。 */
export function evidenceTimeline(records, entityId, code) {
  const out = [];
  for (const rec of records) {
    if (rec.type === EVT.EVIDENCE_IMPORTED && rec.data.entityId === entityId && rec.data.code === code) {
      out.push(rec.data.evidence);
    }
  }
  return out;
}
