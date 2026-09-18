import { id, nowIso, hashJson, toMs } from './util.mjs';
import { invalid, notFound, required, unprocessable } from './errors.mjs';
import { appendAudit } from './audit.mjs';
import { getEntity, enrollmentRulebook } from './entities.mjs';

/**
 * 证据 = 材料的合规证明文件，可从合同系统、银行、外部顾问等来源导入。
 * 同一 (实体, 活动, 材料) 只保留一份“生效中”证据：新指纹替换旧指纹（旧件标记 superseded）。
 * 导入按内容指纹去重；每次导入产出可追溯差异（added / duplicated / superseded / rejected）。
 */
const VALID_SOURCES = new Set(['contract', 'bank', 'advisor', 'manual']);

function fingerprintOf(item, source) {
  // documentRef 是外部系统单据号；缺失时退化为内容哈希
  const basis = item.documentRef
    ? { source, documentRef: item.documentRef }
    : { source, materialKey: item.materialKey, content: item.content ?? item.metadata ?? null };
  return hashJson(basis);
}

export function importEvidence(state, entityId, { source, items = [], importedBy = 'system', importedAt }) {
  const entity = getEntity(state, entityId);
  required({ source }, ['source']);
  if (!VALID_SOURCES.has(source)) throw invalid('BAD_SOURCE', `未知证据来源: ${source}（允许: ${[...VALID_SOURCES].join(', ')}）`);
  if (!Array.isArray(items) || items.length === 0) throw invalid('NO_ITEMS', '导入清单为空');

  const at = importedAt || nowIso();
  const report = {
    id: id('imp'),
    source,
    entityId: entity.id,
    startedAt: at,
    added: [],
    duplicated: [],
    superseded: [],
    rejected: [],
  };

  for (const raw of items) {
    const item = normalizeItem(raw);
    if (item.rejected) {
      report.rejected.push({ ref: raw.documentRef ?? null, materialKey: raw.materialKey ?? null, reason: item.rejected });
      continue;
    }
    const { activityKey, materialKey } = item;
    const enrollment = state.enrollments.find((x) => x.entityId === entity.id && x.activityKey === activityKey);
    if (!enrollment) {
      report.rejected.push({ ref: item.documentRef, activityKey, materialKey, reason: '实体未登记该业务活动' });
      continue;
    }
    const rb = enrollmentRulebook(state, enrollment);
    const mat = rb.activities.find((a) => a.key === activityKey)?.materials.find((m) => m.key === materialKey);
    if (!mat) {
      report.rejected.push({ ref: item.documentRef, activityKey, materialKey, reason: `规则 v${rb.version} 不要求该材料` });
      continue;
    }

    const fingerprint = fingerprintOf(item, source);
    const duplicate = state.evidence.find(
      (e) => e.entityId === entity.id && e.activityKey === activityKey && e.materialKey === materialKey &&
        e.fingerprint === fingerprint && e.status !== 'superseded'
    );
    if (duplicate) {
      report.duplicated.push({ evidenceId: duplicate.id, ref: item.documentRef, materialKey: `${activityKey}.${materialKey}` });
      continue;
    }

    const previous = activeEvidence(state, entity.id, activityKey, materialKey);
    const evidence = {
      id: id('ev'),
      entityId: entity.id,
      activityKey,
      materialKey,
      source,
      documentRef: item.documentRef || null,
      issuedAt: item.issuedAt || null,
      expiresAt: item.expiresAt || null,
      uploadedAt: at,
      uploadedBy: importedBy,
      fingerprint,
      status: 'active',
      replacedBy: null,
      metadata: item.metadata || {},
    };
    state.evidence.push(evidence);
    report.added.push({ evidenceId: evidence.id, ref: evidence.documentRef, materialKey: `${activityKey}.${materialKey}` });

    if (previous) {
      previous.status = 'superseded';
      previous.replacedBy = evidence.id;
      previous.supersededAt = at;
      report.superseded.push({
        materialKey: `${activityKey}.${materialKey}`,
        fromEvidenceId: previous.id,
        toEvidenceId: evidence.id,
        fromRef: previous.documentRef,
        toRef: evidence.documentRef,
      });
    }
  }

  report.finishedAt = nowIso();
  report.stats = {
    added: report.added.length,
    duplicated: report.duplicated.length,
    superseded: report.superseded.length,
    rejected: report.rejected.length,
  };
  state.imports.push(report);
  appendAudit(state, {
    actor: importedBy,
    action: 'evidence.import',
    entityId: entity.id,
    details: { importId: report.id, source, stats: report.stats },
  });
  return report;
}

function normalizeItem(raw) {
  const out = { ...raw };
  const missing = ['activityKey', 'materialKey'].filter((f) => !raw[f]);
  if (missing.length) return { ...raw, rejected: `缺少字段: ${missing.join(', ')}` };
  for (const f of ['issuedAt', 'expiresAt']) {
    if (raw[f]) {
      try {
        toMs(raw[f], f);
      } catch (e) {
        return { ...raw, rejected: e.message };
      }
    }
  }
  if (raw.expiresAt && raw.issuedAt && toMs(raw.expiresAt) < toMs(raw.issuedAt)) {
    return { ...raw, rejected: '到期日早于签发日' };
  }
  return out;
}

export function activeEvidence(state, entityId, activityKey, materialKey) {
  return state.evidence.find(
    (e) => e.entityId === entityId && e.activityKey === activityKey && e.materialKey === materialKey && e.status === 'active'
  ) || null;
}

export function evidenceFreshness(evidence, atMs = Date.now()) {
  if (!evidence) return 'missing';
  if (evidence.expiresAt && toMs(evidence.expiresAt) < atMs) return 'expired';
  return 'valid';
}

export function listEvidence(state, entityId) {
  return state.evidence.filter((e) => e.entityId === entityId);
}

/** 最近一次导入的差异报告。 */
export function lastImport(state, entityId = null) {
  const rows = entityId ? state.imports.filter((r) => r.entityId === entityId) : state.imports;
  return rows[rows.length - 1] || null;
}

/* ---------------- 豁免 ---------------- */

export function grantExemption(state, entityId, { activityKey, materialKey, reason, expiresAt = null, grantedBy = 'system' }) {
  const entity = getEntity(state, entityId);
  required({ activityKey, materialKey, reason }, ['activityKey', 'materialKey', 'reason']);
  const live = state.exemptions.find(
    (x) => x.entityId === entityId && x.activityKey === activityKey && x.materialKey === materialKey && !x.revokedAt
  );
  if (live) throw invalid('EXEMPTION_ACTIVE', `该材料已有生效豁免: ${live.id}`);
  const exemption = {
    id: id('ex'),
    entityId,
    activityKey,
    materialKey,
    reason,
    expiresAt,
    grantedBy,
    grantedAt: nowIso(),
    revokedAt: null,
    revokedBy: null,
  };
  state.exemptions.push(exemption);
  appendAudit(state, { actor: grantedBy, action: 'exemption.grant', entityId, details: { activityKey, materialKey, reason, expiresAt } });
  return exemption;
}

export function revokeExemption(state, entityId, exemptionId, { revokedBy = 'system', reason = '' }) {
  const ex = state.exemptions.find((x) => x.id === exemptionId && x.entityId === entityId);
  if (!ex) throw notFound('EXEMPTION_NOT_FOUND', `豁免不存在: ${exemptionId}`);
  if (ex.revokedAt) throw unprocessable('EXEMPTION_REVOKED', `豁免已撤销: ${exemptionId}`);
  ex.revokedAt = nowIso();
  ex.revokedBy = revokedBy;
  ex.revokeReason = reason;
  appendAudit(state, { actor: revokedBy, action: 'exemption.revoke', entityId, details: { exemptionId, materialKey: `${ex.activityKey}.${ex.materialKey}`, reason } });
  return ex;
}

export function activeExemption(state, entityId, activityKey, materialKey, atMs = Date.now()) {
  const ex = state.exemptions.find(
    (x) => x.entityId === entityId && x.activityKey === activityKey && x.materialKey === materialKey && !x.revokedAt
  );
  if (!ex) return null;
  if (ex.expiresAt && toMs(ex.expiresAt) < atMs) return null; // 到期豁免不满足材料，但保留记录
  return ex;
}
