import { nowIso, toMs } from './util.mjs';
import { enrollmentRulebook, getEntity } from './entities.mjs';
import { activeEvidence, evidenceFreshness, activeExemption } from './evidence.mjs';

/**
 * 可签约状态引擎。
 * 材料状态机：
 *   satisfied  —— 有生效证据且未过期，或持有有效豁免
 *   blocked    —— 前置材料未满足（生效前置关系）
 *   expired    —— 证据已过期（需更新）
 *   missing    —— 无证据、无豁免
 * 豁免到期同样落入 expired/missing，并在理由中注明。
 * 未满足前置条件的材料即使证据齐全也不能判定完成（blocked）。
 */
export function materialStatus(state, enrollment, material, at = new Date().toISOString()) {
  const atMs = toMs(at);
  const evidence = activeEvidence(state, enrollment.entityId, enrollment.activityKey, material.key);
  const exemption = activeExemption(state, enrollment.entityId, enrollment.activityKey, material.key, atMs);
  const freshness = evidenceFreshness(evidence, atMs);

  const prereqResults = material.prerequisites.map((ref) => {
    const [preAct, preKey] = ref.includes('.') ? ref.split('.') : [enrollment.activityKey, ref];
    const rb = enrollmentRulebook(state, enrollment);
    const preMat = rb.activities.find((a) => a.key === preAct)?.materials.find((m) => m.key === preKey);
    const preEnr = preAct === enrollment.activityKey
      ? enrollment
      : state.enrollments.find((x) => x.entityId === enrollment.entityId && x.activityKey === preAct);
    if (!preMat || !preEnr) return { ref, satisfied: false, reason: '前置活动未登记或材料不存在' };
    const pre = materialStatus(state, preEnr, preMat, at);
    return { ref, satisfied: pre.satisfied, reason: pre.satisfied ? null : pre.blockReason };
  });
  const unsatisfiedPrereqs = prereqResults.filter((p) => !p.satisfied);

  let satisfied = false;
  let state_ = 'missing';
  let blockReason = null;
  let basis = null;

  if (unsatisfiedPrereqs.length) {
    state_ = 'blocked';
    blockReason = `前置材料未满足: ${unsatisfiedPrereqs.map((p) => p.ref).join(', ')}`;
  } else if (exemption) {
    satisfied = true;
    state_ = 'exempted';
    basis = { kind: 'exemption', exemptionId: exemption.id, reason: exemption.reason };
  } else if (freshness === 'valid') {
    satisfied = true;
    state_ = 'satisfied';
    basis = { kind: 'evidence', evidenceId: evidence.id, source: evidence.source, documentRef: evidence.documentRef, expiresAt: evidence.expiresAt };
  } else if (freshness === 'expired') {
    state_ = 'expired';
    blockReason = `证据已于 ${evidence.expiresAt} 过期`;
  } else {
    state_ = 'missing';
    blockReason = '缺少生效证据或豁免';
  }

  return {
    activityKey: enrollment.activityKey,
    materialKey: material.key,
    name: material.name,
    ownerRole: material.ownerRole,
    renewable: material.renewable,
    state: state_,
    satisfied,
    blockReason,
    basis,
    prerequisites: prereqResults,
    evidence: evidence ? { id: evidence.id, source: evidence.source, documentRef: evidence.documentRef, issuedAt: evidence.issuedAt, expiresAt: evidence.expiresAt, status: evidence.status } : null,
    exemption: exemption ? { id: exemption.id, reason: exemption.reason, expiresAt: exemption.expiresAt } : null,
  };
}

/** 评估实体单个登记活动。 */
export function evaluateActivity(state, enrollment, at = new Date().toISOString()) {
  const rb = enrollmentRulebook(state, enrollment);
  const activity = rb.activities.find((a) => a.key === enrollment.activityKey);
  const materials = activity.materials.map((m) => materialStatus(state, enrollment, m, at));
  // 拓扑序：只在所有材料满足时可签约
  const blocking = materials.filter((m) => !m.satisfied);
  return {
    entityId: enrollment.entityId,
    activityKey: activity.key,
    activityName: activity.name,
    rulebookVersion: rb.version,
    signable: blocking.length === 0,
    materials,
    blockingReasons: blocking.map((m) => ({
      materialKey: `${activity.key}.${m.materialKey}`,
      ownerRole: m.ownerRole,
      state: m.state,
      reason: m.blockReason,
    })),
    evaluatedAt: nowIso(),
  };
}

/** 评估实体所有活动并汇总可签约状态。 */
export function evaluateEntity(state, entityId, at = new Date().toISOString()) {
  const entity = getEntity(state, entityId);
  const enrollments = state.enrollments.filter((x) => x.entityId === entityId);
  const activities = enrollments.map((enr) => evaluateActivity(state, enr, at));
  const signable = activities.length > 0 && activities.every((a) => a.signable);
  const blockers = activities.flatMap((a) =>
    a.blockingReasons.map((b) => ({ activityKey: a.activityKey, ...b }))
  );
  return {
    entityId: entity.id,
    entityName: entity.name,
    countryCode: entity.countryCode,
    timeZone: entity.timeZone,
    signable,
    status: signable ? 'ready_to_sign' : 'blocked',
    activities,
    blockers,
    openTasks: state.tasks.filter((t) => t.entityId === entityId && t.status !== 'resolved').length,
    evaluatedAt: nowIso(),
  };
}

/**
 * 根据评估结果同步人工核查任务（幂等）：
 * 每个未满足材料对应一个 open 任务，责任角色取规则定义；材料满足后自动 resolve。
 * “程序再次运行后仍能接续人工核查”——任务持久化且重复运行不产生重复任务。
 */
export function syncTasks(state, entityId, actor = 'system', at = new Date().toISOString()) {
  const evaluation = evaluateEntity(state, entityId, at);
  const created = [], resolved = [], kept = [];
  const activeKeys = new Set();

  for (const act of evaluation.activities) {
    for (const m of act.materials) {
      const taskKey = `${act.activityKey}.${m.materialKey}`;
      activeKeys.add(taskKey);
      const open = state.tasks.find(
        (t) => t.entityId === entityId && t.taskKey === taskKey && t.status !== 'resolved'
      );
      if (m.satisfied) {
        if (open) {
          open.status = 'resolved';
          open.resolvedAt = nowIso();
          open.resolvedBy = actor;
          open.resolution = m.state === 'exempted' ? '豁免生效' : '材料满足';
          resolved.push(open);
        }
      } else if (!open) {
        const task = {
          id: `task_${(state.tasks.length + 1).toString(36)}_${Date.now().toString(36)}`,
          entityId,
          taskKey,
          activityKey: act.activityKey,
          materialKey: m.materialKey,
          kind: m.state === 'expired' ? 'renew' : m.state === 'blocked' ? 'unblock' : 'collect',
          status: 'open',
          assigneeRole: m.ownerRole,
          detail: m.blockReason,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        state.tasks.push(task);
        created.push(task);
      } else {
        // 阻断理由可能变化（如前置补齐后从 blocked 变 missing），更新但保留任务身份
        if (open.detail !== m.blockReason || open.kind !== (m.state === 'expired' ? 'renew' : m.state === 'blocked' ? 'unblock' : 'collect')) {
          open.detail = m.blockReason;
          open.kind = m.state === 'expired' ? 'renew' : m.state === 'blocked' ? 'unblock' : 'collect';
          open.updatedAt = nowIso();
        }
        kept.push(open);
      }
    }
  }
  // 规则里已删除的材料对应任务关闭
  for (const t of state.tasks) {
    if (t.entityId === entityId && t.status !== 'resolved' && !activeKeys.has(t.taskKey)) {
      t.status = 'resolved';
      t.resolvedAt = nowIso();
      t.resolvedBy = actor;
      t.resolution = '规则不再要求该材料';
      resolved.push(t);
    }
  }
  return { created: created.map((t) => t.id), resolved: resolved.map((t) => t.id), kept: kept.length, evaluation };
}
