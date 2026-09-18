import { EventStore } from '../core/event-store.mjs';
import { Mutex } from '../core/mutex.mjs';
import { newId, contentHash } from '../core/ids.mjs';
import { toIso } from '../core/clock.mjs';
import { EVT, EVIDENCE_SOURCES } from './events.mjs';
import { createState, applyEvent, evidenceTimeline } from './state.mjs';
import { DomainError, ERR } from './errors.mjs';
import {
  effectiveRuleVersion,
  evaluateEntity,
  diffRuleSpecs,
  flatDiff,
  isEntityAffected,
} from './rules.mjs';

/**
 * 应用服务：命令（写）走互斥串行提交并返回新事件；查询（读）基于重放投影即时计算。
 * 每次命令都是“校验 -> 追加事件 -> 投影跟进”，事件是唯一事实来源，重启重放即可续跑。
 */
export class ComplianceService {
  constructor({ file, clock = () => new Date() } = {}) {
    this.store = new EventStore({ file, clock });
    this.state = createState();
    this.lock = new Mutex();
    this.clock = clock;
  }

  async start() {
    await this.store.start();
    for (const rec of this.store.all()) applyEvent(this.state, rec);
  }

  async close() {
    await this.store.close();
  }

  now() {
    return toIso(this.clock());
  }

  // ---------- 写入辅助 ----------

  async commit(type, data, actor, extraMeta = {}) {
    return this.lock.run(() => this._append(type, data, actor, extraMeta));
  }

  async commitMany(entries, actor) {
    return this.lock.run(() => this._appendMany(entries, actor));
  }

  /** 假设调用方已持有锁：单条追加并跟进投影。 */
  async _append(type, data, actor, extraMeta = {}) {
    const rec = await this.store.append(type, data, { actor, ...extraMeta });
    applyEvent(this.state, rec);
    return rec;
  }

  /** 假设调用方已持有锁：同一事务内多条事件按序追加。 */
  async _appendMany(entries, actor) {
    const out = [];
    for (const [type, data, meta = {}] of entries) {
      out.push(await this._append(type, data, actor, meta));
    }
    return out;
  }

  _getEntity(entityId) {
    const e = this.state.entities.get(entityId);
    if (!e) throw new DomainError(ERR.NOT_FOUND, `实体不存在: ${entityId}`);
    return e;
  }

  _getCountry(countryId) {
    const c = this.state.countries.get(countryId);
    if (!c) throw new DomainError(ERR.NOT_FOUND, `国家/地区不存在: ${countryId}`);
    return c;
  }

  // ---------- 基础资料 ----------

  async registerCountry({ code, name }, actor = 'admin') {
    const exists = [...this.state.countries.values()].find((c) => c.code === code);
    if (exists) throw new DomainError(ERR.DUPLICATE, `国家/地区代码已存在: ${code}`);
    const id = newId('cty');
    return this.commit(EVT.COUNTRY_REGISTERED, { id, code, name }, actor);
  }

  async registerActivity({ countryId, code, name }, actor = 'admin') {
    this._getCountry(countryId);
    const key = `${countryId}:${code}`;
    if (this.state.activities.has(key))
      throw new DomainError(ERR.DUPLICATE, `业务活动已存在: ${code}`);
    return this.commit(EVT.ACTIVITY_REGISTERED, { countryId, code, name }, actor);
  }

  async registerRole({ code, name }, actor = 'admin') {
    if (this.state.roles.has(code)) throw new DomainError(ERR.DUPLICATE, `责任角色已存在: ${code}`);
    return this.commit(EVT.ROLE_REGISTERED, { code, name }, actor);
  }

  async onboardEntity({ name, countryId, activities }, actor = 'admin') {
    this._getCountry(countryId);
    for (const code of activities) {
      if (!this.state.activities.has(`${countryId}:${code}`))
        throw new DomainError(ERR.VALIDATION, `国家下未登记的业务活动: ${code}`, { activity: code });
    }
    const id = newId('ent');
    await this.commit(EVT.ENTITY_ONBOARDED, {
      id,
      name,
      countryId,
      activities: [...new Set(activities)],
      onboardedAt: this.now(),
    }, actor);
    return id;
  }

  // ---------- 规则版本 ----------

  _validateSpecs(countryId, specs) {
    const errors = [];
    const activityCodes = new Set(
      [...this.state.activities.values()].filter((a) => a.countryId === countryId).map((a) => a.code),
    );
    for (const [activity, body] of Object.entries(specs.activities ?? {})) {
      if (!activityCodes.has(activity)) {
        errors.push({ activity, error: 'UNKNOWN_ACTIVITY' });
        continue;
      }
      const codes = new Set();
      for (const req of body.requirements ?? []) {
        if (!req.code || !req.name) errors.push({ activity, req: req.code, error: 'MISSING_CODE_OR_NAME' });
        if (codes.has(req.code)) errors.push({ activity, req: req.code, error: 'DUPLICATE_REQUIREMENT' });
        codes.add(req.code);
        if (!this.state.roles.has(req.ownerRole))
          errors.push({ activity, req: req.code, error: 'UNKNOWN_OWNER_ROLE', ownerRole: req.ownerRole });
      }
      for (const req of body.requirements ?? []) {
        for (const pre of req.prerequisites ?? []) {
          if (!codes.has(pre))
            errors.push({ activity, req: req.code, error: 'UNKNOWN_PREREQUISITE', prerequisite: pre });
        }
      }
      // 前置依赖环会导致门禁永远无法判定，发布时直接拒绝。
      const byCode = new Map((body.requirements ?? []).map((r) => [r.code, r]));
      for (const req of body.requirements ?? []) {
        const seen = new Set([req.code]);
        const stack = [...(req.prerequisites ?? [])];
        while (stack.length) {
          const cur = stack.pop();
          if (cur === req.code) {
            errors.push({ activity, req: req.code, error: 'PREREQUISITE_CYCLE' });
            break;
          }
          if (seen.has(cur)) continue;
          seen.add(cur);
          stack.push(...(byCode.get(cur)?.prerequisites ?? []));
        }
      }
    }
    return errors;
  }

  /**
   * 发布规则新版本：校验通过才追加；保留完整版本快照与相对上一版的差异；
   * 仅给适用要求发生变化的实体生成通知。
   */
  async publishRules(countryId, specs, { actor = 'legal', effectiveFrom = null } = {}) {
    return this.lock.run(async () => {
      this._getCountry(countryId);
      const errors = this._validateSpecs(countryId, specs);
      if (errors.length)
        throw new DomainError(ERR.VALIDATION, '规则规格校验失败', { errors });

      const versions = this.state.ruleVersions.get(countryId) ?? [];
      const previous = versions[versions.length - 1] ?? null;
      const version = (previous?.version ?? 0) + 1;
      const diff = previous ? diffRuleSpecs(previous.specs, specs) : null;
      const publishedAt = this.now();

      const entries = [
        [
          EVT.RULES_PUBLISHED,
          {
            countryId,
            version,
            publishedAt,
            effectiveFrom: effectiveFrom ? toIso(effectiveFrom) : null,
            actor,
            specs: structuredClone(specs),
            diff,
          },
        ],
      ];

      if (diff) {
        for (const entity of this.state.entities.values()) {
          if (entity.countryId !== countryId) continue;
          if (!isEntityAffected(diff, previous.specs, specs, entity.activities)) continue;
          const notification = {
            id: newId('ntf'),
            type: 'RULE_CHANGE',
            ruleVersion: version,
            countryId,
            createdAt: publishedAt,
            summary: {
              added: diff.added,
              removed: diff.removed,
              changed: diff.changed.map((c) => c.key),
            },
          };
          entries.push([
            EVT.NOTIFICATION_CREATED,
            { entityId: entity.id, notification },
          ]);
        }
      }
      const recs = await this._appendMany(entries, actor);
      return { version, publishedAt, diff, events: recs };
    });
  }

  // ---------- 证据导入（合同 / 银行 / 外部顾问） ----------

  /**
   * 幂等导入：
   * 1) idempotencyKey 相同 → 直接回放首次结果，不产生新证据；
   * 2) 内容哈希与当前活动证据一致 → 记 IMPORT_DEDUPLICATED(SAME_CONTENT)；
   * 3) 当前活动证据存在但内容不同 → 旧证据 SUPERSEDED（附字段级差异），新证据生效；
   * 4) 无活动证据 → 直接生效。
   */
  async importEvidence(
    { entityId, code, source, sourceRef, fields = {}, validUntil = null, idempotencyKey = null },
    actor = 'system',
  ) {
    if (!EVIDENCE_SOURCES.includes(source))
      throw new DomainError(ERR.VALIDATION, `不支持的证据来源: ${source}`);
    if (!idempotencyKey) throw new DomainError(ERR.VALIDATION, '缺少 idempotencyKey（重复导入判定依据）');

    return this.lock.run(async () => {
      const entity = this._getEntity(entityId);
      this._assertRequirementKnown(entity, code);

      const importId = contentHash({ idem: idempotencyKey });
      if (this.state.imports.has(importId)) {
        const first = this.state.imports.get(importId);
        await this._append(
          EVT.IMPORT_DEDUPLICATED,
          {
            entityId,
            code,
            source,
            sourceRef,
            importId,
            reason: 'IDEMPOTENCY_REPLAY',
            originalEvidenceId: first.evidenceId,
            at: this.now(),
          },
          actor,
        );
        return { outcome: 'DEDUPLICATED', reason: 'IDEMPOTENCY_REPLAY', evidenceId: first.evidenceId };
      }

      const hash = contentHash({ code, source, sourceRef, fields, validUntil });
      const slot = this.state.evidence.get(entityId)?.get(code);
      const active = slot?.active ?? null;

      if (active && active.contentHash === hash) {
        await this._append(
          EVT.IMPORT_DEDUPLICATED,
          {
            entityId,
            code,
            source,
            sourceRef,
            importId,
            reason: 'SAME_CONTENT',
            originalEvidenceId: active.id,
            at: this.now(),
          },
          actor,
        );
        return { outcome: 'DEDUPLICATED', reason: 'SAME_CONTENT', evidenceId: active.id };
      }

      const evidence = {
        id: newId('evd'),
        code,
        source,
        sourceRef,
        fields: structuredClone(fields),
        validUntil: validUntil ? toIso(validUntil) : null,
        importedAt: this.now(),
        importedBy: actor,
        contentHash: hash,
      };
      const entries = [];
      let fieldChanges = null;
      if (active) {
        fieldChanges = flatDiff(
          { ...active.fields, sourceRef: active.sourceRef, validUntil: active.validUntil },
          { ...evidence.fields, sourceRef: evidence.sourceRef, validUntil: evidence.validUntil },
          { label: `evidence:${code}` },
        ).changes;
        entries.push([
          EVT.EVIDENCE_SUPERSEDED,
          {
            entityId,
            code,
            previousEvidenceId: active.id,
            at: evidence.importedAt,
            by: actor,
            reason: `新导入证据（${source}/${sourceRef}）替代旧证据`,
            fieldChanges,
          },
        ]);
      }
      entries.push([EVT.EVIDENCE_IMPORTED, { entityId, code, importId, evidence }]);
      await this._appendMany(entries, actor);
      return {
        outcome: active ? 'SUPERSEDED' : 'IMPORTED',
        evidenceId: evidence.id,
        supersededEvidenceId: active?.id ?? null,
        fieldChanges,
      };
    });
  }

  /** 材料 code 必须出现在该国最新发布版本的规则中（任一业务活动下）。 */
  _assertRequirementKnown(entity, code) {
    const versions = this.state.ruleVersions.get(entity.countryId) ?? [];
    const latest = versions[versions.length - 1];
    if (!latest)
      throw new DomainError(ERR.VALIDATION, '该国尚未发布规则，无法核对材料归属');
    const known = Object.values(latest.specs.activities ?? {}).some((a) =>
      (a.requirements ?? []).some((r) => r.code === code),
    );
    if (!known)
      throw new DomainError(ERR.UNKNOWN_REQUIREMENT, `当前规则版本 v${latest.version} 中不存在该材料: ${code}`);
  }

  // ---------- 豁免 / 撤销 ----------

  async grantExemption({ entityId, code, reason, grantedBy, expiresAt = null }, actor = grantedBy ?? 'legal') {
    const entity = this._getEntity(entityId);
    this._assertRequirementKnown(entity, code);
    return this.commit(
      EVT.EXEMPTION_GRANTED,
      {
        entityId,
        code,
        reason,
        grantedBy: grantedBy ?? actor,
        grantedAt: this.now(),
        expiresAt: expiresAt ? toIso(expiresAt) : null,
      },
      actor,
    );
  }

  async revokeExemption({ entityId, code, reason, revokedBy }, actor = revokedBy ?? 'legal') {
    const entity = this._getEntity(entityId);
    const ex = this.state.exemptions.get(entityId)?.get(code);
    if (!ex) throw new DomainError(ERR.NOT_FOUND, `不存在有效豁免，无法撤销: ${code}`);
    if (ex.status === 'REVOKED')
      throw new DomainError(ERR.CONFLICT, '豁免已被撤销，不能重复撤销');
    return this.commit(
      EVT.EXEMPTION_REVOKED,
      {
        entityId,
        code,
        reason,
        revokedBy: revokedBy ?? actor,
        revokedAt: this.now(),
      },
      actor,
    );
  }

  // ---------- 人工核查 ----------

  async recordReview({ entityId, code, decision, reviewer, note = null, evidenceId = null }, actor = reviewer) {
    if (!['CHALLENGE', 'CLEAR'].includes(decision))
      throw new DomainError(ERR.VALIDATION, 'decision 仅支持 CHALLENGE / CLEAR');
    const entity = this._getEntity(entityId);
    this._assertRequirementKnown(entity, code);
    return this.commit(
      EVT.REQUIREMENT_REVIEWED,
      {
        entityId,
        code,
        decision,
        reviewer: reviewer ?? actor,
        reviewedAt: this.now(),
        note,
        evidenceId,
      },
      actor,
    );
  }

  /**
   * 法务开业审查：以当前时刻生效规则重算全部门禁。
   * expectedVersion 用于乐观并发——跨时区同时补材料/撤豁免时，
   * 只有基于最新实体版本的审查才能落定，否则返回 409 风格错误并附当前阻断理由。
   * 未满足前置条件时 CANNOT_COMPLETE，不能标记完成。
   */
  async completeOpeningReview({ entityId, reviewer, note = null, expectedVersion }, actor = reviewer) {
    return this.lock.run(async () => {
      const entity = this._getEntity(entityId);
      if (expectedVersion !== undefined && expectedVersion !== entity.version) {
        const status = this.entityStatus(entityId);
        throw new DomainError(ERR.CONCURRENT_MODIFICATION, '实体状态在审查期间已被更新，请基于最新阻断理由重审', {
          currentVersion: entity.version,
          expectedVersion,
          currentBlockers: status.blocking,
        });
      }
      const status = this.entityStatus(entityId);
      if (!status.canSign) {
        throw new DomainError(ERR.PREREQUISITES_NOT_MET, '仍有前置条件未满足，开业审查不能标记完成', {
          blockers: status.blocking,
          ruleBasis: status.ruleBasis,
        });
      }
      const id = newId('rev');
      const rec = await this._append(
        EVT.OPENING_REVIEW_COMPLETED,
        {
          id,
          entityId,
          reviewer: reviewer ?? actor,
          reviewedAt: this.now(),
          expectedVersion: entity.version,
          snapshot: status.requirements,
          blockers: [],
          note,
          decision: 'PASS',
        },
        actor,
      );
      return { id, reviewedAt: rec.data.reviewedAt, status };
    });
  }

  async markNotificationRead({ entityId, notificationId }, actor = 'legal') {
    const note = this.state.notifications.get(entityId)?.find((n) => n.id === notificationId);
    if (!note) throw new DomainError(ERR.NOT_FOUND, '通知不存在');
    if (note.read) return { alreadyRead: true };
    return this.commit(EVT.NOTIFICATION_READ, { entityId, notificationId }, actor);
  }

  // ---------- 查询 ----------

  entityStatus(entityId, at = null) {
    const entity = this._getEntity(entityId);
    const versions = this.state.ruleVersions.get(entity.countryId) ?? [];
    const now = at ? toIso(at) : this.now();
    const picked = effectiveRuleVersion(versions, now);
    if (!picked) {
      return {
        entityId,
        entityVersion: entity.version,
        evaluatedAt: now,
        ruleVersion: null,
        ruleBasis: 'NONE_PUBLISHED',
        requirements: [],
        blocking: [],
        canSign: false,
        signingStatus: 'PENDING_RULES',
      };
    }
    const result = evaluateEntity(
      {
        specs: picked.version.specs,
        activityCodes: entity.activities,
        evidenceByCode: this.state.evidence.get(entityId) ?? new Map(),
        exemptionByCode: this.state.exemptions.get(entityId) ?? new Map(),
        reviewByCode: this.state.reviews.get(entityId) ?? new Map(),
      },
      now,
    );
    return {
      entityId,
      entityName: entity.name,
      entityVersion: entity.version,
      evaluatedAt: now,
      ruleVersion: picked.version.version,
      ruleBasis: picked.basis,
      ...result,
    };
  }

  evidenceHistory(entityId, code) {
    this._getEntity(entityId);
    return evidenceTimeline(this.store.all(), entityId, code);
  }

  notifications(entityId) {
    this._getEntity(entityId);
    return this.state.notifications.get(entityId) ?? [];
  }

  ruleVersions(countryId) {
    this._getCountry(countryId);
    return this.state.ruleVersions.get(countryId) ?? [];
  }

  /** 审计时间线：实体相关事件按 seq 排列，可选类型与时间范围过滤。 */
  auditTimeline(entityId, { types = null, from = null, to = null } = {}) {
    this._getEntity(entityId);
    const typeSet = types ? new Set(types) : null;
    return this.store
      .all()
      .filter((rec) => {
        const aboutEntity =
          rec.data.entityId === entityId ||
          (rec.type === EVT.NOTIFICATION_CREATED && rec.data.entityId === entityId);
        if (!aboutEntity) return false;
        if (typeSet && !typeSet.has(rec.type)) return false;
        const at = new Date(rec.meta.at).getTime();
        if (from && at < new Date(from).getTime()) return false;
        if (to && at > new Date(to).getTime()) return false;
        return true;
      })
      .map((rec) => ({
        seq: rec.seq,
        at: rec.meta.at,
        actor: rec.meta.actor,
        type: rec.type,
        data: rec.data,
      }));
  }

  /** 阻断理由（含前置链）的可读视图，供法务核对。 */
  blockingReasons(entityId, at = null) {
    const status = this.entityStatus(entityId, at);
    return status.blocking.map((r) => ({
      requirement: r.code,
      name: r.name,
      ownerRole: r.ownerRole,
      status: r.status,
      exempt: r.exempt,
      evidenceState: r.evidenceState,
      reasons: r.blockers.map((b) => describeBlocker(b)),
    }));
  }
}

export function describeBlocker(blocker) {
  if (typeof blocker === 'string') {
    switch (blocker) {
      case 'MISSING_EVIDENCE':
        return { code: blocker, text: '缺少生效证据材料' };
      case 'EVIDENCE_EXPIRED':
        return { code: blocker, text: '证据材料已过期，需重新导入' };
      case 'EXEMPTION_EXPIRED':
        return { code: blocker, text: '豁免已到期且未续期' };
      case 'LEGAL_CHALLENGE_OPEN':
        return { code: blocker, text: '法务核查存在未消除的质询' };
      default:
        return { code: blocker, text: blocker };
    }
  }
  if (blocker.code === 'PREREQUISITE_NOT_MET')
    return { code: blocker.code, text: `前置材料未满足: ${blocker.missing.join(', ')}`, missing: blocker.missing };
  if (blocker.code === 'REQUIREMENT_UNKNOWN')
    return { code: blocker.code, text: `规则引用了未知前置: ${blocker.missing.join(', ')}`, missing: blocker.missing };
  return blocker;
}
