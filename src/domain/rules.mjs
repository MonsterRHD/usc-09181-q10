import { id, nowIso, canonicalJson, hashJson } from './util.mjs';
import { invalid, notFound, required } from './errors.mjs';
import { appendAudit } from './audit.mjs';

/**
 * 规则手册（rulebook）是不可变的版本快照。
 * 每次“发布”都产生新版本；旧版本保留，已登记实体按登记版本评估，
 * 新版本生效后只通知受材料要求变化影响的实体。
 */

export function addCountry(state, { code, name }, actor = 'system') {
  required({ code, name }, ['code', 'name']);
  if (state.countries.some((c) => c.code === code)) throw invalid('COUNTRY_EXISTS', `国家已存在: ${code}`);
  const country = { code, name, createdAt: nowIso() };
  state.countries.push(country);
  appendAudit(state, { actor, action: 'country.add', entityId: null, details: { code, name } });
  return country;
}

export function registerRole(state, { key, name }, actor = 'system') {
  required({ key, name }, ['key', 'name']);
  if (state.roles.some((r) => r.key === key)) throw invalid('ROLE_EXISTS', `角色已存在: ${key}`);
  const role = { key, name };
  state.roles.push(role);
  appendAudit(state, { actor, action: 'role.add', details: { key, name } });
  return role;
}

/** 校验并规范化一份活动/材料定义。材料之间可用 prerequisites 表达生效前置关系。 */
function normalizeActivities(activities, knownRoles) {
  if (!Array.isArray(activities) || activities.length === 0) {
    throw invalid('NO_ACTIVITIES', '规则手册至少包含一个业务活动');
  }
  const materialOwners = new Map();
  const out = activities.map((act) => {
    required(act, ['key', 'name']);
    const materials = (act.materials || []).map((m) => {
      required(m, ['key', 'name', 'ownerRole']);
      if (!knownRoles.has(m.ownerRole)) throw invalid('UNKNOWN_ROLE', `材料 ${m.key} 的责任角色不存在: ${m.ownerRole}`);
      materialOwners.set(`${act.key}.${m.key}`, m.ownerRole);
      return {
        key: m.key,
        name: m.name,
        ownerRole: m.ownerRole,
        renewable: m.renewable !== false,
        prerequisites: Array.isArray(m.prerequisites) ? [...new Set(m.prerequisites)] : [],
      };
    });
    return { key: act.key, name: act.name, materials };
  });

  const actIndex = new Map(out.map((a) => [a.key, new Map(a.materials.map((m) => [m.key, m]))]));
  const refOf = (actKey, raw) => (raw.includes('.') ? raw.split('.') : [actKey, raw]);
  for (const act of out) {
    for (const m of act.materials) {
      for (const pre of m.prerequisites) {
        const [preAct, preMat] = refOf(act.key, pre);
        if (!actIndex.get(preAct)?.has(preMat)) {
          throw invalid('BAD_PREREQUISITE', `材料 ${act.key}.${m.key} 的前置不存在: ${pre}`);
        }
      }
    }
  }
  // 前置依赖在跨活动全图上也不能成环
  detectGlobalCycle(out, actIndex, refOf);
  return out;
}

function detectGlobalCycle(activities, actIndex, refOf) {
  const color = new Map(); // `${act}.${mat}` -> 0/1/2
  const keyOf = (a, m) => `${a}.${m}`;
  const visit = (actKey, matKey, path) => {
    const key = keyOf(actKey, matKey);
    const mark = color.get(key);
    if (mark === 1) throw invalid('PREREQUISITE_CYCLE', `材料前置依赖存在环: ${[...path, key].join(' -> ')}`);
    if (mark === 2) return;
    color.set(key, 1);
    const mat = actIndex.get(actKey).get(matKey);
    for (const pre of mat.prerequisites) {
      const [preAct, preMat] = refOf(actKey, pre);
      visit(preAct, preMat, [...path, key]);
    }
    color.set(key, 2);
  };
  for (const act of activities) {
    for (const matKey of actIndex.get(act.key).keys()) visit(act.key, matKey, []);
  }
}

/**
 * 发布新版本。effectiveFrom 为空表示立即生效。
 * 返回 {rulebook, affected} —— affected 为受材料结构变化影响的实体登记列表。
 */
export function publishRulebook(state, { activities, effectiveFrom = null, note = '', publishedBy = 'system' }, actor = publishedBy) {
  const knownRoles = new Set(state.roles.map((r) => r.key));
  const normalized = normalizeActivities(activities, knownRoles);
  const prev = currentRulebook(state);
  const version = prev ? prev.version + 1 : 1;
  const rulebook = {
    id: id('rb'),
    version,
    activities: normalized,
    effectiveFrom: effectiveFrom || nowIso(),
    publishedAt: nowIso(),
    publishedBy,
    note,
    digest: hashJson(normalized),
  };
  state.rulebooks.push(rulebook);
  // 到点生效由 effectiveAt 决定；activeRulebookId 指向“最新已发布”，状态引擎按 effectiveFrom 判断
  state.activeRulebookId = rulebook.id;

  const changes = prev ? diffActivities(prev.activities, normalized) : { added: [], removed: [], changed: [] };
  appendAudit(state, {
    actor,
    action: 'rulebook.publish',
    details: { version: rulebook.version, effectiveFrom: rulebook.effectiveFrom, note, changes },
  });
  return { rulebook, changes, previousVersion: prev?.version ?? null };
}

export function currentRulebook(state, at = new Date().toISOString()) {
  const effective = state.rulebooks
    .filter((rb) => rb.effectiveFrom <= at)
    .sort((a, b) => b.version - a.version)[0];
  return effective || null;
}

export function getRulebook(state, version) {
  const rb = state.rulebooks.find((x) => x.version === Number(version)) || state.rulebooks.find((x) => x.id === version);
  if (!rb) throw notFound('RULEBOOK_NOT_FOUND', `规则版本不存在: ${version}`);
  return rb;
}

/** 结构差异：新增/删除的材料，以及 owner、名称、前置集合变化的材料。 */
export function diffActivities(prevActivities, nextActivities) {
  const flatten = (acts) => {
    const map = new Map();
    for (const a of acts) for (const m of a.materials) map.set(`${a.key}.${m.key}`, { activity: a.key, ...m });
    return map;
  };
  const before = flatten(prevActivities);
  const after = flatten(nextActivities);
  const added = [], removed = [], changed = [];
  for (const [key, m] of after) {
    if (!before.has(key)) added.push(key);
    else {
      const p = before.get(key);
      const diff = {};
      if (p.name !== m.name) diff.name = { from: p.name, to: m.name };
      if (p.ownerRole !== m.ownerRole) diff.ownerRole = { from: p.ownerRole, to: m.ownerRole };
      if (p.renewable !== m.renewable) diff.renewable = { from: p.renewable, to: m.renewable };
      const preA = [...p.prerequisites].sort();
      const preB = [...m.prerequisites].sort();
      if (canonicalJson(preA) !== canonicalJson(preB)) diff.prerequisites = { from: preA, to: preB };
      if (Object.keys(diff).length) changed.push({ material: key, ...diff });
    }
  }
  for (const key of before.keys()) if (!after.has(key)) removed.push(key);
  return { added, removed, changed };
}

/** 登记实体适用某版本某活动（见 entities.mjs），此处只提供材料查询。 */
export function findMaterial(rulebook, activityKey, materialKey) {
  const act = rulebook.activities.find((a) => a.key === activityKey);
  return act?.materials.find((m) => m.key === materialKey) || null;
}
