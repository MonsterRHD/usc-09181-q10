import { JsonStore } from './store.mjs';
import * as rules from './rules.mjs';
import * as entities from './entities.mjs';
import * as evidence from './evidence.mjs';
import * as status from './status.mjs';
import * as reviews from './reviews.mjs';
import * as notify from './notify.mjs';
import { verifyAuditChain, auditTimeline, appendAudit } from './audit.mjs';

/**
 * 应用服务：组合领域函数并在每次变更后持久化。
 * 纯内存领域逻辑 + 边界处 save()，使崩溃/重启后能从磁盘状态接续人工核查。
 */
export class ComplianceService {
  constructor(storeOrPath) {
    this.store = typeof storeOrPath === 'string' || storeOrPath instanceof URL ? new JsonStore(storeOrPath) : storeOrPath;
  }

  get state() {
    return this.store.get();
  }

  // ---- 主数据 ----
  addCountry(input, actor) { return this.#commit(() => rules.addCountry(this.state, input, actor)); }
  registerRole(input, actor) { return this.#commit(() => rules.registerRole(this.state, input, actor)); }
  createEntity(input, actor) { return this.#commit(() => entities.createEntity(this.state, input, actor)); }
  enrollActivity(entityId, input, actor) { return this.#commit(() => entities.enrollActivity(this.state, entityId, input, actor)); }

  // ---- 规则版本 ----
  publishRulebook(input, actor) {
    return this.#commit(() => {
      const result = rules.publishRulebook(this.state, input, actor);
      // 通知只针对受材料结构变化影响的实体
      const notifications = notify.notifyRuleChange(this.state, result.rulebook, actor || input.publishedBy);
      return { ...result, notifications };
    });
  }
  migrateEnrollment(entityId, activityKey, version, actor) {
    return this.#commit(() => entities.migrateEnrollment(this.state, entityId, activityKey, version, actor));
  }
  listRulebooks() { return this.state.rulebooks.map(({ id, version, effectiveFrom, publishedAt, publishedBy, note, digest }) => ({ id, version, effectiveFrom, publishedAt, publishedBy, note, digest })); }
  getRulebook(version) { return rules.getRulebook(this.state, version); }

  // ---- 证据与豁免 ----
  importEvidence(entityId, input) { return this.#commit(() => evidence.importEvidence(this.state, entityId, input)); }
  grantExemption(entityId, input) { return this.#commit(() => evidence.grantExemption(this.state, entityId, input)); }
  revokeExemption(entityId, exemptionId, input = {}) { return this.#commit(() => evidence.revokeExemption(this.state, entityId, exemptionId, input)); }

  // ---- 状态与任务 ----
  evaluate(entityId, at) { return status.evaluateEntity(this.state, entityId, at); }
  syncTasks(entityId, actor, at) { return this.#commit(() => status.syncTasks(this.state, entityId, actor, at)); }
  listTasks(entityId = null) {
    return entityId ? this.state.tasks.filter((t) => t.entityId === entityId) : this.state.tasks;
  }

  // ---- 审查 ----
  openReview(entityId, input) { return this.#commit(() => reviews.openReview(this.state, entityId, input || {})); }
  checkBlocker(reviewId, input, actor) { return this.#commit(() => reviews.checkBlocker(this.state, reviewId, input, actor)); }
  completeReview(reviewId, input) { return this.#commit(() => reviews.completeReview(this.state, reviewId, input || {})); }  reviewBundle(reviewId) { return reviews.reviewBundle(this.state, reviewId); }

  // ---- 通知 / 审计 ----
  pendingNotifications(entityId) { return notify.pendingNotifications(this.state, entityId); }
  markNotificationDelivered(id) { return this.#commit(() => notify.markDelivered(this.state, id)); }
  auditTimeline(filter) { return auditTimeline(this.state, filter); }
  verifyAudit() { return verifyAuditChain(this.state); }

  /**
   * 跨实体批量重算（定时任务/重启续跑入口），幂等：
   * - 人工核查任务随状态开合且不重复
   * - 证据过期生成按证据去重的通知
   * 返回受影响实体清单。
   */
  reevaluateAll(actor = 'system', at) {
    return this.#commit(() => {
      const out = [];
      const evaluations = [];
      for (const e of this.state.entities) {
        const sync = status.syncTasks(this.state, e.id, actor, at);
        evaluations.push(sync.evaluation);
        out.push({ entityId: e.id, signable: sync.evaluation.signable, created: sync.created.length, resolved: sync.resolved.length });
      }
      const expiryNotes = notify.notifyExpiredMaterials(this.state, evaluations, actor);
      appendAudit(this.state, { actor, action: 'system.reevaluate', details: { entities: out.length, expiryNotifications: expiryNotes.length } });
      return out;
    });
  }

  #commit(fn) {
    const result = fn();
    this.store.save();
    return result;
  }
}
