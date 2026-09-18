import { isPast } from '../core/clock.mjs';

/**
 * 规则引擎全部是纯函数：给定规则版本快照 + 实体证据/豁免/核查投影 + 当前时刻，
 * 计算每个所需材料的状态与阻断理由。不写状态，便于随时重算与测试。
 *
 * 规则版本 specs 结构：
 * {
 *   activities: {
 *     [activityCode]: {
 *       requirements: [
 *         { code, name, ownerRole, prerequisites: [reqCode...], renewalDays? }
 *       ]
 *     }
 *   }
 * }
 */

export const BLOCKER = {
  MISSING_EVIDENCE: 'MISSING_EVIDENCE',
  EVIDENCE_EXPIRED: 'EVIDENCE_EXPIRED',
  EXEMPTION_EXPIRED: 'EXEMPTION_EXPIRED',
  PREREQUISITE_NOT_MET: 'PREREQUISITE_NOT_MET',
  LEGAL_CHALLENGE_OPEN: 'LEGAL_CHALLENGE_OPEN',
  REQUIREMENT_UNKNOWN: 'REQUIREMENT_UNKNOWN',
};

/** 选取当前时刻生效的规则版本：effectiveFrom 已到的最新版本；一个都未生效则取最早版本。 */
export function effectiveRuleVersion(versions, now) {
  if (!versions?.length) return null;
  const t = new Date(now).getTime();
  const live = versions
    .filter((v) => new Date(v.effectiveFrom ?? v.publishedAt).getTime() <= t)
    .sort((a, b) => b.version - a.version);
  if (live.length) return { version: live[0], basis: 'EFFECTIVE' };
  const upcoming = [...versions].sort((a, b) => a.version - b.version)[0];
  return { version: upcoming, basis: 'UPCOMING' };
}

/** 实体在某版本下适用的全部材料要求（跨业务活动去重，保留首次出现的规格）。 */
export function applicableRequirements(specs, activityCodes) {
  const byCode = new Map();
  for (const act of activityCodes) {
    for (const spec of specs.activities?.[act]?.requirements ?? []) {
      if (!byCode.has(spec.code)) byCode.set(spec.code, { ...spec, activities: [act] });
      else byCode.get(spec.code).activities.push(act);
    }
  }
  return byCode;
}

function validExemption(exemption, now) {
  if (!exemption || exemption.status !== 'GRANTED') return null;
  if (exemption.expiresAt && isPast(exemption.expiresAt, now)) return 'EXPIRED';
  return 'VALID';
}

/**
 * 计算单个材料要求的评估结果。
 * inputs: { spec, activeEvidence, exemption, review, satisfiedCodes:Set(已满足的要求code) }
 */
export function evaluateRequirement(inputs, now) {
  const { spec, activeEvidence = null, exemption = null, review = null, satisfiedCodes } = inputs;
  const blockers = [];

  const exemptionState = validExemption(exemption, now);
  const exempt = exemptionState === 'VALID';
  if (exemptionState === 'EXPIRED') blockers.push(BLOCKER.EXEMPTION_EXPIRED);
  if (exemption?.status === 'REVOKED') {
    // 撤销信息本身保留在审计时间线；撤销后回到“需证据”路径。
  }

  let evidenceState = 'ABSENT';
  if (activeEvidence) {
    if (activeEvidence.validUntil && isPast(activeEvidence.validUntil, now)) {
      evidenceState = 'EXPIRED';
      blockers.push(BLOCKER.EVIDENCE_EXPIRED);
    } else {
      evidenceState = 'VALID';
    }
  }

  if (!exempt && evidenceState === 'ABSENT') blockers.push(BLOCKER.MISSING_EVIDENCE);

  const missingPrerequisites = (spec.prerequisites ?? []).filter((p) => !satisfiedCodes.has(p));
  if (missingPrerequisites.length) {
    blockers.push({ code: BLOCKER.PREREQUISITE_NOT_MET, missing: missingPrerequisites });
  }

  if (review?.decision === 'CHALLENGE') blockers.push(BLOCKER.LEGAL_CHALLENGE_OPEN);

  const satisfied = blockers.length === 0;
  let status;
  if (!satisfied && blockers.some((b) => b === BLOCKER.MISSING_EVIDENCE)) status = 'MISSING';
  else if (!satisfied && blockers.some((b) => b === BLOCKER.EVIDENCE_EXPIRED)) status = 'EXPIRED';
  else if (blockers.some((b) => (b?.code ?? b) === BLOCKER.PREREQUISITE_NOT_MET))
    status = 'PENDING_PREREQUISITE';
  else if (blockers.includes(BLOCKER.LEGAL_CHALLENGE_OPEN)) status = 'CHALLENGED';
  else if (exempt) status = 'EXEMPT';
  else status = 'READY';

  return {
    code: spec.code,
    name: spec.name,
    ownerRole: spec.ownerRole,
    activities: spec.activities ?? [],
    prerequisites: spec.prerequisites ?? [],
    status,
    satisfied,
    exempt,
    evidenceState,
    blockers,
    evidenceId: activeEvidence?.id ?? null,
    validUntil: activeEvidence?.validUntil ?? exemption?.expiresAt ?? null,
    review: review ? { decision: review.decision, reviewer: review.reviewer, at: review.reviewedAt } : null,
  };
}

/**
 * 计算实体当前可签约状态。前置依赖可能成链：
 * 一个要求只有当其全部前置都已评估（或前置不属于适用集合）时才评估，
 * 保证前置未满足的要求也会带着 PREREQUISITE_NOT_MET 出现在阻断清单里。
 */
export function evaluateEntity({ specs, activityCodes, evidenceByCode, exemptionByCode, reviewByCode }, now) {
  const applicable = applicableRequirements(specs, activityCodes);
  const satisfiedCodes = new Set();
  const results = new Map();
  const pending = new Map(applicable);

  const assess = (code, spec, extraBlocker = null) => {
    const r = evaluateRequirement(
      {
        spec,
        activeEvidence: evidenceByCode.get(code)?.active ?? null,
        exemption: exemptionByCode.get(code) ?? null,
        review: reviewByCode.get(code) ?? null,
        satisfiedCodes: new Set(satisfiedCodes),
      },
      now,
    );
    if (extraBlocker) {
      r.blockers.push(extraBlocker);
      r.satisfied = false;
      r.status = extraBlocker.code === BLOCKER.REQUIREMENT_UNKNOWN ? 'PENDING_PREREQUISITE' : r.status;
    }
    results.set(code, r);
    pending.delete(code);
    if (r.satisfied) satisfiedCodes.add(code);
  };

  let guard = applicable.size + 1;
  while (pending.size && guard-- > 0) {
    let progressed = false;
    for (const [code, spec] of [...pending]) {
      const prereqs = spec.prerequisites ?? [];
      const unknown = prereqs.filter((p) => !applicable.has(p));
      const waiting = prereqs.filter((p) => applicable.has(p) && !results.has(p));
      if (unknown.length) {
        assess(code, spec, { code: BLOCKER.REQUIREMENT_UNKNOWN, missing: unknown });
        progressed = true;
        continue;
      }
      if (waiting.length) continue; // 等前置先评估
      assess(code, spec);
      progressed = true;
    }
    if (!progressed) break;
  }

  // 防御性兜底：规则发布已拒绝依赖环，理论上不可达；万一存在，显式阻断而非静默放行。
  for (const [code, spec] of pending) {
    assess(code, spec, { code: BLOCKER.PREREQUISITE_NOT_MET, missing: ['<PREREQUISITE_CYCLE>'] });
  }

  const requirements = [...results.values()];
  const blocking = requirements.filter((r) => !r.satisfied);
  return {
    requirements,
    blocking,
    canSign: blocking.length === 0,
    signingStatus: blocking.length === 0 ? 'READY_TO_SIGN' : 'BLOCKED',
  };
}

/** 字段级差异：用于证据重复导入/更新与规则版本对比。只比较一层扁平字段。 */
export function flatDiff(before, after, { label = 'change' } = {}) {
  const changes = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of [...keys].sort()) {
    const a = before ? normalize(before[key]) : undefined;
    const b = after ? normalize(after[key]) : undefined;
    if (a === b) continue;
    if (before && !(key in (before ?? {}))) changes.push({ kind: 'added', field: key, after: after[key] });
    else if (after && !(key in (after ?? {}))) changes.push({ kind: 'removed', field: key, before: before[key] });
    else changes.push({ kind: 'changed', field: key, before: before?.[key], after: after?.[key] });
  }
  return { label, changes };
}

function normalize(v) {
  if (v === undefined) return undefined;
  return typeof v === 'object' ? JSON.stringify(v) : v;
}

/**
 * 两个规则版本的结构化差异。要求以 `${activityCode}:${reqCode}` 为键。
 * 返回 { added, removed, changed }，changed 给出名称/责任角色/前置/续期天数的字段差异。
 */
export function diffRuleSpecs(previous, next) {
  const index = (specs) => {
    const m = new Map();
    for (const [activity, body] of Object.entries(specs?.activities ?? {})) {
      for (const req of body.requirements ?? []) m.set(`${activity}:${req.code}`, { ...req, activity });
    }
    return m;
  };
  const a = index(previous);
  const b = index(next);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, spec] of b) {
    if (!a.has(key)) added.push(key);
    else {
      const old = a.get(key);
      const fieldChanges = [];
      for (const field of ['name', 'ownerRole', 'renewalDays']) {
        if (normalize(old[field]) !== normalize(spec[field])) {
          fieldChanges.push({ field, before: old[field], after: spec[field] });
        }
      }
      if (normalize(old.prerequisites ?? []) !== normalize(spec.prerequisites ?? [])) {
        fieldChanges.push({ field: 'prerequisites', before: old.prerequisites ?? [], after: spec.prerequisites ?? [] });
      }
      if (fieldChanges.length) changed.push({ key, fieldChanges });
    }
  }
  for (const key of a.keys()) if (!b.has(key)) removed.push(key);
  return { added, removed, changed };
}

/** 规则发布后，判定实体是否受影响：其适用要求发生新增/删除/变更（活动维度的全键）。 */
export function isEntityAffected(diff, previousSpecs, nextSpecs, activityCodes) {
  const keysOf = (specs) => {
    const s = new Set();
    for (const act of activityCodes) {
      for (const req of specs?.activities?.[act]?.requirements ?? []) s.add(`${act}:${req.code}`);
    }
    return s;
  };
  const prevApplicable = keysOf(previousSpecs);
  const nextApplicable = keysOf(nextSpecs);
  if (diff.added.some((k) => nextApplicable.has(k))) return true;
  if (diff.removed.some((k) => prevApplicable.has(k))) return true;
  if (diff.changed.some((c) => nextApplicable.has(c.key) || prevApplicable.has(c.key))) return true;
  return false;
}
