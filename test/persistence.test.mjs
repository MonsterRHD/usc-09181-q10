import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ComplianceService } from '../src/domain/service.mjs';

const dir = mkdtempSync(join(tmpdir(), 'compliance-'));
const file = join(dir, 'state.json');

test.after(() => rmSync(dir, { recursive: true, force: true }));

function bootstrap(svc) {
  svc.addCountry({ code: 'DE', name: '德国' });
  svc.registerRole({ key: 'tax', name: '税务' });
  svc.registerRole({ key: 'legal', name: '法务' });
  svc.publishRulebook({
    activities: [{
      key: 'local_sales', name: '在岸销售',
      materials: [
        { key: 'business_license', name: '营业许可', ownerRole: 'legal' },
        { key: 'vat', name: '增值税号', ownerRole: 'tax' },
      ],
    }],
  });
  const ent = svc.createEntity({ name: '德国公司', countryCode: 'DE' });
  svc.enrollActivity(ent.id, { activityKey: 'local_sales' });
  return ent;
}

test('重启后从磁盘接续：未结任务、开放审查、阻断状态与审计链完整保留', () => {
  const svc1 = new ComplianceService(file);
  const ent = bootstrap(svc1);
  svc1.importEvidence(ent.id, { source: 'bank', items: [{ activityKey: 'local_sales', materialKey: 'vat', documentRef: 'VAT-1' }] });
  const review = svc1.openReview(ent.id, { openedBy: 'legal-berlin', timeZone: 'Europe/Berlin' });
  svc1.syncTasks(ent.id, 'biz');
  const openTasksBefore = svc1.listTasks(ent.id).filter((t) => t.status === 'open').length;
  assert.equal(openTasksBefore, 1);
  const seqBefore = svc1.state.audit.length;
  assert.ok(seqBefore > 5);

  // 模拟“程序再次运行”：新实例读同一文件
  const svc2 = new ComplianceService(file);
  assert.equal(svc2.state.entities.length, 1);
  const st = svc2.evaluate(ent.id);
  assert.equal(st.signable, false);
  assert.equal(st.blockers[0].materialKey, 'local_sales.business_license');
  // 任务与开放审查接续，不重复生成
  assert.equal(svc2.syncTasks(ent.id, 'system').created.length, 0);
  assert.equal(svc2.state.reviews[0].status, 'open');
  assert.equal(svc2.state.reviews[0].id, review.id);
  // 审计链跨重启仍可验证，序号继续单调
  assert.equal(svc2.verifyAudit(), null);
  assert.equal(svc2.state.audit.length, seqBefore);

  // 人工补齐后在新进程完成审查
  svc2.importEvidence(ent.id, { source: 'contract', items: [{ activityKey: 'local_sales', materialKey: 'business_license', documentRef: 'LIC-1', expiresAt: '2030-01-01T00:00:00Z' }] });
  const done = svc2.completeReview(review.id, { actor: 'legal-sg' });
  assert.equal(done.evaluation.signable, true);
  assert.equal(svc2.state.entities[0].status, 'ready_to_sign');

  // 第三次启动：结论落盘，审计链依然完整
  const svc3 = new ComplianceService(file);
  assert.equal(svc3.state.entities[0].status, 'ready_to_sign');
  assert.equal(svc3.state.reviews[0].decision, 'approved');
  assert.equal(svc3.verifyAudit(), null);
});

test('reevaluateAll 幂等：多实体重复运行任务不翻倍，只随材料状态开合', () => {
  const svc = new ComplianceService(join(dir, 'batch.json'));
  svc.addCountry({ code: 'SG', name: '新加坡' });
  svc.registerRole({ key: 'legal', name: '法务' });
  svc.publishRulebook({
    activities: [{ key: 's', name: 'S', materials: [{ key: 'lic', name: '许可', ownerRole: 'legal' }] }],
  });
  const e1 = svc.createEntity({ name: 'SG-1', countryCode: 'SG' });
  const e2 = svc.createEntity({ name: 'SG-2', countryCode: 'SG' });
  svc.enrollActivity(e1.id, { activityKey: 's' });
  svc.enrollActivity(e2.id, { activityKey: 's' });

  const first = svc.reevaluateAll('cron');
  assert.equal(first.reduce((n, r) => n + r.created, 0), 2);
  assert.equal(svc.reevaluateAll('cron').reduce((n, r) => n + r.created, 0), 0);
  assert.equal(svc.state.tasks.length, 2);

  svc.importEvidence(e1.id, { source: 'manual', items: [{ activityKey: 's', materialKey: 'lic', documentRef: 'L1' }] });
  const third = svc.reevaluateAll('cron');
  const row1 = third.find((r) => r.entityId === e1.id);
  assert.equal(row1.signable, true);
  assert.equal(row1.resolved, 1);
  const row2 = third.find((r) => r.entityId === e2.id);
  assert.equal(row2.signable, false);
});
