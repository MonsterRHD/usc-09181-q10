import test from 'node:test';
import assert from 'node:assert/strict';
import { ComplianceService } from '../src/domain/service.mjs';
import { JsonStore } from '../src/domain/store.mjs';
import { DomainError } from '../src/domain/errors.mjs';

/**
 * 端到端业务剧本：
 * 制造企业首次在 DE / SG 设销售实体 -> 规则与前置建模 -> 多来源证据导入/去重
 * -> 前置阻断 -> 跨时区法务审查（补许可、撤豁免、换税务材料）-> 放行。
 */
function fresh() {
  return new ComplianceService(new JsonStore(':memory:'));
}

function seed() {
  const svc = fresh();
  svc.addCountry({ code: 'DE', name: '德国' });
  svc.addCountry({ code: 'SG', name: '新加坡' });
  svc.registerRole({ key: 'tax', name: '税务' });
  svc.registerRole({ key: 'legal', name: '法务' });
  svc.registerRole({ key: 'data', name: '数据合规' });
  svc.registerRole({ key: 'biz', name: '业务' });
  // 规则 v1：在岸销售。vat 税号 -> 数据跨境登记依赖税号；营业许可无前置
  svc.publishRulebook({
    note: '首版开业规则',
    activities: [{
      key: 'local_sales',
      name: '在岸签约销售',
      materials: [
        { key: 'business_license', name: '当地营业许可', ownerRole: 'legal', renewable: true },
        { key: 'vat', name: '增值税号', ownerRole: 'tax', renewable: false },
        { key: 'data_crossborder', name: '数据跨境备案', ownerRole: 'data', renewable: true, prerequisites: ['vat'] },
      ],
    }],
  });
  return svc;
}

test('基础建模：未知国家不能建实体，前置依赖成环被拒', () => {
  const svc = seed();
  assert.throws(() => svc.createEntity({ name: 'X', countryCode: 'FR' }), (e) => e.code === 'UNKNOWN_COUNTRY');

  assert.throws(
    () => svc.publishRulebook({
      activities: [{
        key: 'a', name: 'A',
        materials: [
          { key: 'm1', name: 'M1', ownerRole: 'tax', prerequisites: ['m2'] },
          { key: 'm2', name: 'M2', ownerRole: 'tax', prerequisites: ['m1'] },
        ],
      }],
    }),
    (e) => e.code === 'PREREQUISITE_CYCLE'
  );
  assert.throws(
    () => svc.publishRulebook({
      activities: [{ key: 'a', name: 'A', materials: [{ key: 'm1', name: 'M1', ownerRole: 'tax', prerequisites: ['ghost'] }] }],
    }),
    (e) => e.code === 'BAD_PREREQUISITE'
  );

  // 跨活动成环同样被拒：a.x -> b.y -> a.x
  assert.throws(
    () => svc.publishRulebook({
      activities: [
        { key: 'a', name: 'A', materials: [{ key: 'x', name: 'X', ownerRole: 'tax', prerequisites: ['b.y'] }] },
        { key: 'b', name: 'B', materials: [{ key: 'y', name: 'Y', ownerRole: 'tax', prerequisites: ['a.x'] }] },
      ],
    }),
    (e) => e.code === 'PREREQUISITE_CYCLE'
  );
});

test('完整开业剧本：前置阻断 -> 三来源导入与去重 -> 豁免与撤销 -> 过期 -> 跨时区审查放行', () => {
  const svc = seed();
  const de = svc.createEntity({ name: '欧洲销售公司', countryCode: 'DE', timeZone: 'Europe/Berlin' });
  svc.enrollActivity(de.id, { activityKey: 'local_sales' });

  // 1) 初始：全部缺失，不可签约；任务同步生成三条 open 任务
  let status = svc.evaluate(de.id);
  assert.equal(status.signable, false);
  assert.equal(status.blockers.length, 3);
  let sync = svc.syncTasks(de.id, 'biz');
  assert.equal(sync.created.length, 3);
  // 重复同步不产生重复任务（幂等接续）
  assert.equal(svc.syncTasks(de.id, 'biz').created.length, 0);

  // 2) 先导入数据跨境备案：前置 vat 未满足 -> 证据在但材料仍 blocked，不能完成
  const dataImport = svc.importEvidence(de.id, {
    source: 'advisor',
    items: [{
      activityKey: 'local_sales', materialKey: 'data_crossborder',
      documentRef: 'ADV-DCB-001', expiresAt: '2030-12-31T00:00:00Z',
    }],
  });
  assert.equal(dataImport.stats.added, 1);
  status = svc.evaluate(de.id, '2026-09-18T00:00:00Z');
  const dcb = status.activities[0].materials.find((m) => m.materialKey === 'data_crossborder');
  assert.equal(dcb.state, 'blocked');
  assert.match(dcb.blockReason, /前置材料未满足.*vat/);

  // 3) 合同系统导入营业许可；银行导入 VAT；重复导入（同源同单号）去重
  svc.importEvidence(de.id, {
    source: 'contract',
    items: [{ activityKey: 'local_sales', materialKey: 'business_license', documentRef: 'CT-LIC-7788', issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2028-01-01T00:00:00Z' }],
  });
  const bankImport = svc.importEvidence(de.id, {
    source: 'bank',
    items: [{ activityKey: 'local_sales', materialKey: 'vat', documentRef: 'DE-VAT-113' }],
  });
  assert.equal(bankImport.stats.added, 1);
  const dupImport = svc.importEvidence(de.id, {
    source: 'bank',
    items: [{ activityKey: 'local_sales', materialKey: 'vat', documentRef: 'DE-VAT-113' }],
  });
  assert.deepEqual(dupImport.stats, { added: 0, duplicated: 1, superseded: 0, rejected: 0 });

  // vat 满足后，data_crossborder 自动解除阻断
  status = svc.evaluate(de.id, '2026-09-18T00:00:00Z');
  assert.equal(status.signable, true);
  assert.equal(status.status, 'ready_to_sign');
  // 任务随之自动 resolve
  sync = svc.syncTasks(de.id, 'biz');
  assert.equal(sync.resolved.length, 3);

  // 4) 许可过期：状态变 expired，再次阻断；产生 renew 任务
  status = svc.evaluate(de.id, '2028-06-01T00:00:00Z');
  assert.equal(status.signable, false);
  assert.equal(status.blockers[0].state, 'expired');
  sync = svc.syncTasks(de.id, 'legal', '2028-06-01T00:00:00Z');
  assert.equal(sync.created.length, 1);
  assert.equal(sync.created && svc.listTasks(de.id).find((t) => t.status === 'open').kind, 'renew');

  // 5) 法务在柏林时区先给许可开豁免 -> 可签约；新加坡时区同事随后撤销豁免 -> 重新阻断
  const ex = svc.grantExemption(de.id, {
    activityKey: 'local_sales', materialKey: 'business_license',
    reason: '主管机关宽限至换证完成', expiresAt: '2028-09-01T00:00:00Z', grantedBy: 'legal-berlin',
  });
  assert.equal(svc.evaluate(de.id, '2028-06-01T00:00:00Z').signable, true);
  svc.revokeExemption(de.id, ex.id, { revokedBy: 'legal-sg', reason: '宽限撤销，必须先换证' });
  status = svc.evaluate(de.id, '2028-06-01T00:00:00Z');
  assert.equal(status.signable, false);
  assert.equal(status.blockers[0].state, 'expired');

  // 6) 跨时区审查：未满足时强制拒绝完成（未满足前置条件不能标记完成）
  const review = svc.openReview(de.id, { openedBy: 'legal-sg', timeZone: 'Asia/Singapore', note: '开业前复核' });
  let blocked;
  assert.throws(() => {
    try {
      svc.completeReview(review.id, { actor: 'legal-sg', at: '2028-06-01T00:00:00Z' });
    } catch (e) { blocked = e; throw e; }
  }, DomainError);
  assert.equal(blocked.code, 'PRECONDITIONS_UNMET');
  assert.ok(blocked.details.blockers.length >= 1);
  svc.checkBlocker(review.id, { materialKey: 'local_sales.business_license', confirmed: true, comment: '已通知柏林换证' }, 'legal-sg');

  // 柏林同事导入新许可（合同来源、新单号）：旧件变 superseded，差异可追溯
  const renewal = svc.importEvidence(de.id, {
    source: 'contract',
    items: [{ activityKey: 'local_sales', materialKey: 'business_license', documentRef: 'CT-LIC-9900', issuedAt: '2028-06-10T00:00:00Z', expiresAt: '2030-06-10T00:00:00Z' }],
  });
  assert.equal(renewal.stats.superseded, 1);
  assert.equal(renewal.superseded[0].fromRef, 'CT-LIC-7788');
  assert.equal(renewal.superseded[0].toRef, 'CT-LIC-9900');

  // 7) 复核通过：实体置 ready_to_sign，重复完成被拒
  const passed = svc.completeReview(review.id, { actor: 'legal-sg', note: '材料齐备', at: '2028-06-15T00:00:00Z' });
  assert.equal(passed.evaluation.signable, true);
  assert.equal(svc.state.entities.find((e) => e.id === de.id).status, 'ready_to_sign');
  assert.throws(() => svc.completeReview(review.id, { actor: 'legal-sg' }), (e) => e.code === 'REVIEW_CLOSED');

  // 8) 审计时间线记录了全部关键动作，哈希链完整
  const timeline = svc.auditTimeline({ entityId: de.id });
  const actions = timeline.map((r) => r.action);
  for (const a of ['entity.create', 'activity.enroll', 'evidence.import', 'exemption.grant', 'exemption.revoke', 'review.open', 'review.complete.rejected', 'review.complete.approved']) {
    assert.ok(actions.includes(a), `审计缺少 ${a}`);
  }
  assert.equal(svc.verifyAudit(), null);
  return { svc, deId: de.id };
});

test('规则发版：保留历史版本，只通知受影响实体；迁移后按新版本评估', () => {
  // 独立搭建场景
  const s = seed();
  const de = s.createEntity({ name: '德国公司', countryCode: 'DE', timeZone: 'Europe/Berlin' });
  const sg = s.createEntity({ name: '新加坡公司', countryCode: 'SG', timeZone: 'Asia/Singapore' });
  s.enrollActivity(de.id, { activityKey: 'local_sales' });
  s.enrollActivity(sg.id, { activityKey: 'local_sales' });
  // 德国先满足 v1 全部材料
  for (const [source, ref, mat, expiresAt] of [
    ['contract', 'LIC-DE', 'business_license', '2030-01-01T00:00:00Z'],
    ['bank', 'VAT-DE', 'vat', null],
    ['advisor', 'DCB-DE', 'data_crossborder', '2030-01-01T00:00:00Z'],
  ]) {
    s.importEvidence(de.id, { source, items: [{ activityKey: 'local_sales', materialKey: mat, documentRef: ref, ...(expiresAt ? { expiresAt } : {}) }] });
  }
  assert.equal(s.evaluate(de.id).signable, true);

  // v2：数据备案新增前置（数据处理协议 dpa），并新增材料；新加坡无材料 -> 两实体均受影响
  s.publishRulebook({
    note: '强化数据跨境要求',
    activities: [{
      key: 'local_sales',
      name: '在岸签约销售',
      materials: [
        { key: 'business_license', name: '当地营业许可', ownerRole: 'legal', renewable: true },
        { key: 'vat', name: '增值税号', ownerRole: 'tax', renewable: false },
        { key: 'dpa', name: '数据处理协议', ownerRole: 'data', renewable: true },
        { key: 'data_crossborder', name: '数据跨境备案', ownerRole: 'data', renewable: true, prerequisites: ['vat', 'dpa'] },
      ],
    }],
  });

  // 通知只发给受影响实体（两个都是），且每个实体仅一条（去重）
  const pending = s.pendingNotifications();
  assert.equal(pending.length, 2);
  const deNote = pending.find((n) => n.entityId === de.id);
  assert.deepEqual(deNote.payload.activities[0].changes.added.sort(), ['local_sales.dpa']);
  // 再发一份无变化的 v3：无人受影响，不产生通知
  s.publishRulebook({
    note: '仅措辞修订（结构不变）',
    activities: [{
      key: 'local_sales', name: '在岸签约销售',
      materials: [
        { key: 'business_license', name: '当地营业许可', ownerRole: 'legal', renewable: true },
        { key: 'vat', name: '增值税号', ownerRole: 'tax', renewable: false },
        { key: 'dpa', name: '数据处理协议', ownerRole: 'data', renewable: true },
        { key: 'data_crossborder', name: '数据跨境备案', ownerRole: 'data', renewable: true, prerequisites: ['vat', 'dpa'] },
      ],
    }],
  });
  assert.equal(s.pendingNotifications().length, 2);

  // 登记仍按 v1 评估（口径冻结）；历史版本可查
  assert.equal(s.getRulebook(1).version, 1);
  assert.equal(s.evaluate(de.id).rulebookVersion || s.evaluate(de.id).activities[0].rulebookVersion, 1);

  // 德国人工核查后迁移到 v3：dpa 缺失导致重新阻断
  s.migrateEnrollment(de.id, 'local_sales', 3);
  const st = s.evaluate(de.id);
  assert.equal(st.activities[0].rulebookVersion, 3);
  assert.equal(st.signable, false);
  assert.ok(st.blockers.some((b) => b.materialKey === 'local_sales.dpa'));
  // data_crossborder 因 dpa 前置被阻断
  const dcb = st.activities[0].materials.find((m) => m.materialKey === 'data_crossborder');
  assert.equal(dcb.state, 'blocked');
});

test('导入校验：未登记活动、规则不要求的材料、坏日期进入 rejected 且可追溯', () => {
  const svc = seed();
  const de = svc.createEntity({ name: '德国公司', countryCode: 'DE' });
  svc.enrollActivity(de.id, { activityKey: 'local_sales' });
  const report = svc.importEvidence(de.id, {
    source: 'advisor',
    items: [
      { activityKey: 'local_sales', materialKey: 'vat', documentRef: 'OK-1' },
      { activityKey: 'local_sales', materialKey: 'ghost', documentRef: 'X' },
      { activityKey: 'not_enrolled', materialKey: 'vat', documentRef: 'Y' },
      { activityKey: 'local_sales', materialKey: 'vat', documentRef: 'BAD', expiresAt: 'not-a-date' },
      { materialKey: 'vat' },
    ],
  });
  assert.equal(report.stats.added, 1);
  assert.equal(report.stats.rejected, 4);
  assert.ok(report.rejected.some((r) => r.reason.includes('不要求该材料')));
  assert.ok(report.rejected.some((r) => r.reason.includes('未登记')));
  assert.ok(report.rejected.some((r) => r.reason.includes('合法 ISO 时间')));
  assert.ok(report.rejected.some((r) => r.reason.includes('缺少字段')));
  // 被拒记录不影响状态：vat 已满足，剩余两项材料阻断
  assert.equal(svc.evaluate(de.id).blockers.length, 2);
});
