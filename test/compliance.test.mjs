import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ComplianceService } from '../src/domain/compliance-service.mjs';
import { EVT } from '../src/domain/events.mjs';
import { DomainError } from '../src/domain/errors.mjs';

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

async function makeService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-'));
  const file = path.join(dir, 'events.jsonl');
  const svc = new ComplianceService({ file, clock: () => new Date('2026-09-18T00:00:00.000Z') });
  await svc.start();
  return { svc, file };
}

const SPECS_V1 = {
  activities: {
    DIRECT_SALES: {
      requirements: [
        { code: 'TAX_ID', name: '当地税号登记', ownerRole: 'TAX', prerequisites: [] },
        { code: 'LOCAL_LICENSE', name: '当地经营许可', ownerRole: 'LEGAL', prerequisites: ['TAX_ID'] },
        { code: 'DATA_CROSSBORDER', name: '数据跨境备案', ownerRole: 'DATA', prerequisites: ['LOCAL_LICENSE'] },
      ],
    },
  },
};

async function bootstrap() {
  const { svc, file } = await makeService();
  await svc.registerRole({ code: 'TAX', name: '税务负责人' });
  await svc.registerRole({ code: 'LEGAL', name: '法务负责人' });
  await svc.registerRole({ code: 'DATA', name: '数据合规负责人' });
  const cty = await svc.registerCountry({ code: 'DE', name: '德国' });
  await svc.registerActivity({ countryId: cty.data.id, code: 'DIRECT_SALES', name: '直销' });
  await svc.publishRules(cty.data.id, SPECS_V1);
  const entityId = await svc.onboardEntity({
    name: '欧洲销售有限公司',
    countryId: cty.data.id,
    activities: ['DIRECT_SALES'],
  });
  return { svc, file, countryId: cty.data.id, entityId };
}

test('初始状态：三项材料全部阻断，且不能完成开业审查', async () => {
  const { svc, entityId } = await bootstrap();
  const status = svc.entityStatus(entityId);
  assert.equal(status.signingStatus, 'BLOCKED');
  assert.equal(status.canSign, false);
  assert.deepEqual(status.blocking.map((r) => r.code).sort(), [
    'DATA_CROSSBORDER',
    'LOCAL_LICENSE',
    'TAX_ID',
  ]);

  // 前置链：LOCAL_LICENSE 缺少自身证据与前置；DATA_CROSSBORDER 仅呈现前置未满足
  const license = status.requirements.find((r) => r.code === 'LOCAL_LICENSE');
  assert.ok(license.blockers.some((b) => b === 'MISSING_EVIDENCE'));
  assert.ok(license.blockers.some((b) => b?.code === 'PREREQUISITE_NOT_MET'));

  await assert.rejects(
    () => svc.completeOpeningReview({ entityId, reviewer: 'legal-de' }),
    (err) => err instanceof DomainError && err.code === 'PREREQUISITES_NOT_MET',
  );
});

test('前置未满足时，即使材料自身齐全也不能签约；按链补齐后放行', async () => {
  const { svc, entityId } = await bootstrap();

  // 直接导入最末端的数据跨境材料：前置未满足，仍阻断
  const r1 = await svc.importEvidence(
    { entityId, code: 'DATA_CROSSBORDER', source: 'ADVISOR', sourceRef: 'ADV-2026-001', fields: { ref: 'DPA-9' }, validUntil: FUTURE, idempotencyKey: 'k-data' },
    'advisor-de',
  );
  assert.equal(r1.outcome, 'IMPORTED');
  assert.equal(svc.entityStatus(entityId).canSign, false);

  await svc.importEvidence(
    { entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'BNK-TAX-1', fields: { taxNo: 'DE999' }, validUntil: FUTURE, idempotencyKey: 'k-tax' },
    'bank-de',
  );
  // 税号已满足，但许可缺失：许可阻断（缺证据），数据备案继续等许可
  let s = svc.entityStatus(entityId);
  assert.equal(s.blocking.find((r) => r.code === 'TAX_ID'), undefined);
  assert.ok(s.blocking.find((r) => r.code === 'LOCAL_LICENSE'));
  assert.ok(s.blocking.find((r) => r.code === 'DATA_CROSSBORDER'));

  await svc.importEvidence(
    { entityId, code: 'LOCAL_LICENSE', source: 'CONTRACT', sourceRef: 'CT-LIC-1', fields: { licenseNo: 'HZ-1' }, validUntil: FUTURE, idempotencyKey: 'lic' },
    'sales-de',
  );
  s = svc.entityStatus(entityId);
  assert.equal(s.canSign, true);
  assert.equal(s.signingStatus, 'READY_TO_SIGN');

  const review = await svc.completeOpeningReview({ entityId, reviewer: 'legal-de' });
  assert.equal(review.status.canSign, true);
});

test('证据导入：幂等重放、同内容去重、更新替代产生字段级差异', async () => {
  const { svc, entityId } = await bootstrap();
  const base = { entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'BNK-1', validUntil: FUTURE };

  const first = await svc.importEvidence({ ...base, fields: { taxNo: 'A' }, idempotencyKey: 'idem-1' });
  assert.equal(first.outcome, 'IMPORTED');

  // 相同 idempotencyKey：回放，不产生新证据
  const replay = await svc.importEvidence({ ...base, fields: { taxNo: 'A' }, idempotencyKey: 'idem-1' });
  assert.equal(replay.outcome, 'DEDUPLICATED');
  assert.equal(replay.reason, 'IDEMPOTENCY_REPLAY');
  assert.equal(replay.evidenceId, first.evidenceId);

  // 不同键但内容哈希一致：同内容去重
  const sameContent = await svc.importEvidence({ ...base, fields: { taxNo: 'A' }, idempotencyKey: 'idem-2' });
  assert.equal(sameContent.reason, 'SAME_CONTENT');

  // 新内容：旧证据被替代，差异可追溯
  const updated = await svc.importEvidence(
    { ...base, fields: { taxNo: 'B', office: 'Berlin' }, idempotencyKey: 'idem-3' },
  );
  assert.equal(updated.outcome, 'SUPERSEDED');
  assert.equal(updated.supersededEvidenceId, first.evidenceId);
  const changedFields = updated.fieldChanges.filter((c) => c.kind === 'changed').map((c) => c.field);
  assert.ok(changedFields.includes('taxNo'));

  const history = svc.evidenceHistory(entityId, 'TAX_ID');
  assert.equal(history.length, 2);
  assert.equal(history[0].id, first.evidenceId);
  assert.equal(history[1].id, updated.evidenceId);
});

test('材料过期立即阻断签约状态', async () => {
  const { svc, entityId } = await bootstrap();
  await svc.importEvidence({
    entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'B', fields: { taxNo: 'X' },
    validUntil: PAST, idempotencyKey: 'exp-1',
  });
  const tax = svc.entityStatus(entityId).requirements.find((r) => r.code === 'TAX_ID');
  assert.equal(tax.status, 'EXPIRED');
  assert.ok(tax.blockers.includes('EVIDENCE_EXPIRED'));
  assert.equal(svc.entityStatus(entityId).canSign, false);

  const reasons = svc.blockingReasons(entityId);
  assert.ok(JSON.stringify(reasons).includes('已过期'));
});

test('豁免使材料满足，撤销后立即恢复阻断；过期豁免不算豁免', async () => {
  const { svc, entityId } = await bootstrap();

  await svc.grantExemption({
    entityId, code: 'DATA_CROSSBORDER', reason: '暂无本地个人数据', grantedBy: 'legal-de',
  });
  // 但前置链仍未满足：许可与税号缺失，数据备案自身豁免不解除链上阻断
  assert.equal(svc.entityStatus(entityId).canSign, false);

  // 补齐链上其他材料
  await svc.importEvidence({ entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'B1', fields: { taxNo: 'T' }, validUntil: FUTURE, idempotencyKey: 't1' });
  await svc.importEvidence({ entityId, code: 'LOCAL_LICENSE', source: 'CONTRACT', sourceRef: 'L1', fields: { no: 'L' }, validUntil: FUTURE, idempotencyKey: 'l1' });
  const s = svc.entityStatus(entityId);
  const data = s.requirements.find((r) => r.code === 'DATA_CROSSBORDER');
  assert.equal(data.exempt, true);
  assert.equal(data.status, 'EXEMPT');
  assert.equal(s.canSign, true);

  // 跨时区法务撤销豁免：立即恢复阻断
  await svc.revokeExemption({ entityId, code: 'DATA_CROSSBORDER', reason: '业务改为存储客户数据', revokedBy: 'legal-sg' });
  assert.equal(svc.entityStatus(entityId).canSign, false);

  await assert.rejects(
    () => svc.revokeExemption({ entityId, code: 'DATA_CROSSBORDER', reason: '再次撤销', revokedBy: 'legal-sg' }),
    (e) => e.code === 'CONFLICT',
  );

  // 带到期日的豁免，到期后不满足
  await svc.grantExemption({ entityId, code: 'DATA_CROSSBORDER', reason: '过渡安排', grantedBy: 'legal-de', expiresAt: PAST });
  const again = svc.entityStatus(entityId).requirements.find((r) => r.code === 'DATA_CROSSBORDER');
  assert.ok(again.blockers.includes('EXEMPTION_EXPIRED'));
});

test('法务质询未消除时不能签约', async () => {
  const { svc, entityId } = await bootstrap();
  for (const [code, source, ref, key] of [
    ['TAX_ID', 'BANK', 'b', 'k1'],
    ['LOCAL_LICENSE', 'CONTRACT', 'c', 'k2'],
    ['DATA_CROSSBORDER', 'ADVISOR', 'a', 'k3'],
  ]) {
    await svc.importEvidence({ entityId, code, source, sourceRef: ref, fields: { ref }, validUntil: FUTURE, idempotencyKey: key });
  }
  assert.equal(svc.entityStatus(entityId).canSign, true);

  await svc.recordReview({ entityId, code: 'TAX_ID', decision: 'CHALLENGE', reviewer: 'legal-de', note: '税号名称与实体不一致' });
  assert.equal(svc.entityStatus(entityId).canSign, false);
  await svc.recordReview({ entityId, code: 'TAX_ID', decision: 'CLEAR', reviewer: 'legal-de', note: '已补件核对一致' });
  assert.equal(svc.entityStatus(entityId).canSign, true);
});

test('规则发布保留版本与差异，通知只发给受影响实体', async () => {
  const { svc, countryId, entityId } = await bootstrap();

  // 另一个国家 + 实体，不应收到德国规则变更通知
  const fr = await svc.registerCountry({ code: 'FR', name: '法国' });
  await svc.registerActivity({ countryId: fr.data.id, code: 'DIRECT_SALES', name: '直销' });
  await svc.publishRules(fr.data.id, SPECS_V1);
  const frEntity = await svc.onboardEntity({ name: '法国销售公司', countryId: fr.data.id, activities: ['DIRECT_SALES'] });

  const v2 = {
    activities: {
      DIRECT_SALES: {
        requirements: [
          { code: 'TAX_ID', name: '当地税号登记', ownerRole: 'TAX', prerequisites: [] },
          { code: 'LOCAL_LICENSE', name: '当地经营许可', ownerRole: 'LEGAL', prerequisites: ['TAX_ID'] },
          { code: 'DATA_CROSSBORDER', name: '数据跨境备案', ownerRole: 'LEGAL', prerequisites: ['LOCAL_LICENSE'] }, // 责任角色变更
          { code: 'SANCTIONS_FILING', name: '制裁合规备案', ownerRole: 'LEGAL', prerequisites: ['TAX_ID'] }, // 新增
        ],
      },
    },
  };
  const pub = await svc.publishRules(countryId, v2, { actor: 'legal-head' });
  assert.equal(pub.version, 2);
  assert.deepEqual(pub.diff.added, ['DIRECT_SALES:SANCTIONS_FILING']);
  assert.deepEqual(pub.diff.changed.map((c) => c.key), ['DIRECT_SALES:DATA_CROSSBORDER']);
  assert.deepEqual(pub.diff.changed[0].fieldChanges.map((f) => f.field), ['ownerRole']);

  const notes = svc.notifications(entityId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, 'RULE_CHANGE');
  assert.deepEqual(notes[0].summary.added, ['DIRECT_SALES:SANCTIONS_FILING']);
  assert.equal(svc.notifications(frEntity).length, 0);

  // 版本历史完整保留
  const versions = svc.ruleVersions(countryId);
  assert.deepEqual(versions.map((v) => v.version), [1, 2]);
  // 新要求立即进入阻断
  assert.ok(svc.entityStatus(entityId).blocking.some((r) => r.code === 'SANCTIONS_FILING'));
});

test('发布含未知前置/依赖环的规则被拒绝', async () => {
  const { svc, countryId } = await bootstrap();
  const badUnknown = {
    activities: { DIRECT_SALES: { requirements: [{ code: 'X', name: 'x', ownerRole: 'TAX', prerequisites: ['NOPE'] }] } },
  };
  await assert.rejects(() => svc.publishRules(countryId, badUnknown), (e) =>
    e.code === 'VALIDATION' && JSON.stringify(e.details.errors).includes('UNKNOWN_PREREQUISITE'));

  const cyclic = {
    activities: {
      DIRECT_SALES: {
        requirements: [
          { code: 'A', name: 'a', ownerRole: 'TAX', prerequisites: ['B'] },
          { code: 'B', name: 'b', ownerRole: 'TAX', prerequisites: ['A'] },
        ],
      },
    },
  };
  await assert.rejects(() => svc.publishRules(countryId, cyclic), (e) =>
    e.code === 'VALIDATION' && JSON.stringify(e.details.errors).includes('PREREQUISITE_CYCLE'));
});

test('并发：跨时区同时补许可、撤豁免、更新税务材料，审计时间线严格有序且结果一致', async () => {
  const { svc, entityId } = await bootstrap();
  await svc.importEvidence({ entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'b1', fields: { taxNo: 'T' }, validUntil: FUTURE, idempotencyKey: 'c1' });
  await svc.importEvidence({ entityId, code: 'LOCAL_LICENSE', source: 'CONTRACT', sourceRef: 'l1', fields: { no: 'L' }, validUntil: FUTURE, idempotencyKey: 'c2' });
  await svc.grantExemption({ entityId, code: 'DATA_CROSSBORDER', reason: '临时', grantedBy: 'legal-de' });
  assert.equal(svc.entityStatus(entityId).canSign, true);

  const versionBefore = svc.entityStatus(entityId).entityVersion;
  await Promise.all([
    svc.importEvidence({ entityId, code: 'LOCAL_LICENSE', source: 'ADVISOR', sourceRef: 'l2', fields: { no: 'L2' }, validUntil: FUTURE, idempotencyKey: 'c3' }, 'legal-us'),
    svc.revokeExemption({ entityId, code: 'DATA_CROSSBORDER', reason: '策略变更', revokedBy: 'legal-sg' }),
    svc.importEvidence({ entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'b2', fields: { taxNo: 'T2' }, validUntil: FUTURE, idempotencyKey: 'c4' }, 'tax-de'),
  ]);

  const status = svc.entityStatus(entityId);
  assert.equal(status.canSign, false); // 豁免撤销后数据备案无证据
  assert.ok(status.blocking.some((r) => r.code === 'DATA_CROSSBORDER'));
  // 税号更新已生效（版本号连续增长，无丢失更新）
  assert.ok(status.entityVersion > versionBefore);
  assert.equal(status.requirements.find((r) => r.code === 'TAX_ID').evidenceId, svc.evidenceHistory(entityId, 'TAX_ID')[1].id);

  const timeline = svc.auditTimeline(entityId);
  const seqs = timeline.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.ok(timeline.some((e) => e.type === EVT.EXEMPTION_REVOKED && e.actor === 'legal-sg'));
  assert.ok(timeline.some((e) => e.type === EVT.EVIDENCE_SUPERSEDED && e.actor === 'legal-us'));

  // 乐观并发：基于旧版本号的开业审查被拒绝，并回传当前阻断理由
  await assert.rejects(
    () => svc.completeOpeningReview({ entityId, reviewer: 'legal-de', expectedVersion: versionBefore }),
    (e) => e.code === 'CONCURRENT_MODIFICATION' && e.details.currentBlockers.length > 0,
  );
});

test('重启重放：状态、幂等识别、人工核查与审计时间线均可接续', async () => {
  const { svc, file, entityId } = await bootstrap();
  await svc.importEvidence({ entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'b', fields: { taxNo: 'T' }, validUntil: FUTURE, idempotencyKey: 'persist-1' });
  await svc.recordReview({ entityId, code: 'TAX_ID', decision: 'CHALLENGE', reviewer: 'legal-de', note: '待补地址' });
  await svc.close();

  const restarted = new ComplianceService({ file, clock: () => new Date('2026-09-18T00:00:00.000Z') });
  await restarted.start();

  const status = restarted.entityStatus(entityId);
  const tax = status.requirements.find((r) => r.code === 'TAX_ID');
  assert.equal(tax.evidenceState, 'VALID');
  assert.equal(tax.status, 'CHALLENGED');

  // 幂等映射随事件重建：同一键仍是回放而非新证据
  const replay = await restarted.importEvidence({ entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'b', fields: { taxNo: 'T' }, validUntil: FUTURE, idempotencyKey: 'persist-1' });
  assert.equal(replay.reason, 'IDEMPOTENCY_REPLAY');

  const timeline = restarted.auditTimeline(entityId);
  assert.ok(timeline.some((e) => e.type === EVT.REQUIREMENT_REVIEWED && e.data.note === '待补地址'));
  await restarted.close();
});

test('生效时间：未来生效的规则版本不提前改变可签约状态', async () => {
  const { svc, countryId, entityId } = await bootstrap();
  // 先按 v1 满足全部要求（数据备案用豁免）
  await svc.importEvidence({ entityId, code: 'TAX_ID', source: 'BANK', sourceRef: 'b', fields: {}, validUntil: FUTURE, idempotencyKey: 'f1' });
  await svc.importEvidence({ entityId, code: 'LOCAL_LICENSE', source: 'CONTRACT', sourceRef: 'c', fields: {}, validUntil: FUTURE, idempotencyKey: 'f2' });
  await svc.importEvidence({ entityId, code: 'DATA_CROSSBORDER', source: 'ADVISOR', sourceRef: 'a', fields: {}, validUntil: FUTURE, idempotencyKey: 'f3' });
  assert.equal(svc.entityStatus(entityId).canSign, true);

  const v3 = {
    activities: {
      DIRECT_SALES: {
        requirements: [
          ...SPECS_V1.activities.DIRECT_SALES.requirements,
          { code: 'NEW_FILING', name: '新增备案', ownerRole: 'LEGAL', prerequisites: ['TAX_ID'] },
        ],
      },
    },
  };
  await svc.publishRules(countryId, v3, { effectiveFrom: '2030-01-01T00:00:00.000Z' });

  const nowStatus = svc.entityStatus(entityId);
  assert.equal(nowStatus.ruleVersion, 1);
  assert.equal(nowStatus.ruleBasis, 'EFFECTIVE');
  assert.equal(nowStatus.canSign, true);

  const futureStatus = svc.entityStatus(entityId, '2030-06-01T00:00:00.000Z');
  assert.equal(futureStatus.ruleVersion, 2);
  assert.equal(futureStatus.canSign, false);
  assert.ok(futureStatus.blocking.some((r) => r.code === 'NEW_FILING'));
});
