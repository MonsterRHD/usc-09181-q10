import { id, nowIso } from './util.mjs';
import { invalid, notFound, required } from './errors.mjs';
import { appendAudit } from './audit.mjs';
import { currentRulebook, getRulebook, diffActivities } from './rules.mjs';

/**
 * 实体 = 企业在某国设立的销售实体。
 * 每个实体可登记多个业务活动；登记时刻绑定当时生效的规则版本，
 * 使“程序再次运行”后对同一实体的评估口径稳定可追溯。
 */
export function createEntity(state, { name, countryCode, timeZone = 'UTC' }, actor = 'system') {
  required({ name, countryCode }, ['name', 'countryCode']);
  if (!state.countries.some((c) => c.code === countryCode)) {
    throw invalid('UNKNOWN_COUNTRY', `国家未建档: ${countryCode}`);
  }
  if (!isValidTimeZone(timeZone)) throw invalid('BAD_TIMEZONE', `时区不合法: ${timeZone}`);
  const entity = {
    id: id('ent'),
    name,
    countryCode,
    timeZone,
    status: 'forming',
    createdAt: nowIso(),
  };
  state.entities.push(entity);
  appendAudit(state, { actor, action: 'entity.create', entityId: entity.id, details: { name, countryCode, timeZone } });
  return entity;
}

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getEntity(state, entityId) {
  const e = state.entities.find((x) => x.id === entityId);
  if (!e) throw notFound('ENTITY_NOT_FOUND', `实体不存在: ${entityId}`);
  return e;
}

/** 实体登记业务活动，绑定当前生效规则版本；可指定 rulebookVersion 固定口径。 */
export function enrollActivity(state, entityId, { activityKey, rulebookVersion = null }, actor = 'system') {
  const entity = getEntity(state, entityId);
  const rb = rulebookVersion ? getRulebook(state, rulebookVersion) : currentRulebook(state);
  if (!rb) throw invalid('NO_RULEBOOK', '尚未发布任何规则版本，无法登记活动');
  if (!rb.activities.some((a) => a.key === activityKey)) {
    throw invalid('UNKNOWN_ACTIVITY', `规则 v${rb.version} 中不存在活动: ${activityKey}`);
  }
  const existing = state.enrollments.find((x) => x.entityId === entityId && x.activityKey === activityKey);
  if (existing) {
    if (existing.rulebookId === rb.id) throw invalid('ALREADY_ENROLLED', `实体已登记活动 ${activityKey}（规则 v${rb.version}）`);
    existing.rulebookId = rb.id;
    existing.migratedAt = nowIso();
    appendAudit(state, { actor, action: 'activity.migrate', entityId, details: { activityKey, rulebookVersion: rb.version } });
    return { enrollment: existing, migrated: true };
  }
  const enrollment = {
    id: id('enr'),
    entityId,
    activityKey,
    rulebookId: rb.id,
    createdAt: nowIso(),
  };
  state.enrollments.push(enrollment);
  appendAudit(state, { actor, action: 'activity.enroll', entityId, details: { activityKey, rulebookVersion: rb.version } });
  return { enrollment, migrated: false };
}

export function enrollmentRulebook(state, enrollment) {
  return state.rulebooks.find((rb) => rb.id === enrollment.rulebookId);
}

/**
 * 新版本发布后，计算受影响的登记。
 * 口径：相对“上一个已发布版本”本次发布是否改变了该活动的材料结构
 * （新增/删除材料或材料定义变化）。实体即使绑定更旧的版本，
 * 也只在真正有增量的发布时收到通知，避免每次发版全量打扰。
 */
export function affectedEnrollments(state, nextRulebook) {
  const result = [];
  const prev = state.rulebooks
    .filter((rb) => rb.version < nextRulebook.version)
    .sort((a, b) => b.version - a.version)[0] || null;

  for (const enr of state.enrollments) {
    const nextAct = nextRulebook.activities.find((a) => a.key === enr.activityKey);
    if (!nextAct) {
      result.push({ enrollment: enr, changes: { added: [], removed: [enr.activityKey], changed: [] } });
      continue;
    }
    if (!prev) {
      // 首个版本不发通知（实体登记时已知晓全部材料）
      continue;
    }
    const prevAct = prev.activities.find((a) => a.key === enr.activityKey);
    if (!prevAct) {
      result.push({ enrollment: enr, fromVersion: prev.version, changes: { added: [enr.activityKey], removed: [], changed: [] } });
      continue;
    }
    const changes = diffActivities([prevAct], [nextAct]);
    if (changes.added.length || changes.removed.length || changes.changed.length) {
      result.push({ enrollment: enr, fromVersion: prev.version, changes });
    }
  }
  return result;
}

/** 把实体登记活动批量迁移到新版本（人工核查后调用）。 */
export function migrateEnrollment(state, entityId, activityKey, rulebookVersion, actor = 'system') {
  const enr = state.enrollments.find((x) => x.entityId === entityId && x.activityKey === activityKey);
  if (!enr) throw notFound('ENROLLMENT_NOT_FOUND', `实体未登记活动: ${activityKey}`);
  const rb = getRulebook(state, rulebookVersion);
  enr.rulebookId = rb.id;
  enr.migratedAt = nowIso();
  appendAudit(state, { actor, action: 'activity.migrate', entityId, details: { activityKey, rulebookVersion: rb.version } });
  return enr;
}
