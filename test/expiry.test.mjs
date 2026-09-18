import test from 'node:test';
import assert from 'node:assert/strict';
import { ComplianceService } from '../src/domain/service.mjs';
import { JsonStore } from '../src/domain/store.mjs';

test('证据过期：批量重算产生按证据去重的通知，换新证后旧通知不再重复、阻断解除', () => {
  const svc = new ComplianceService(new JsonStore(':memory:'));
  svc.addCountry({ code: 'DE', name: '德国' });
  svc.registerRole({ key: 'legal', name: '法务' });
  svc.publishRulebook({
    activities: [{ key: 'sales', name: '销售', materials: [{ key: 'license', name: '许可', ownerRole: 'legal' }] }],
  });
  const e = svc.createEntity({ name: 'DE', countryCode: 'DE' });
  svc.enrollActivity(e.id, { activityKey: 'sales' });
  svc.importEvidence(e.id, {
    source: 'contract',
    items: [{ activityKey: 'sales', materialKey: 'license', documentRef: 'LIC-OLD', expiresAt: '2028-01-01T00:00:00Z' }],
  });
  assert.equal(svc.evaluate(e.id, '2027-01-01T00:00:00Z').signable, true);

  // 定时任务在 2028 年重算：一条过期通知
  svc.reevaluateAll('cron', '2028-06-01T00:00:00Z');
  let notes = svc.pendingNotifications(e.id);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].kind, 'material.expired');
  assert.equal(notes[0].payload.documentRef, 'LIC-OLD');

  // 再次运行不重复通知；阻断状态仍可从状态接口读到
  svc.reevaluateAll('cron', '2028-06-02T00:00:00Z');
  assert.equal(svc.pendingNotifications(e.id).length, 1);
  assert.equal(svc.evaluate(e.id, '2028-06-02T00:00:00Z').blockers[0].state, 'expired');

  // 导入新证（旧件 superseded），重算后可签约，且不新增通知
  const rep = svc.importEvidence(e.id, {
    source: 'contract',
    items: [{ activityKey: 'sales', materialKey: 'license', documentRef: 'LIC-NEW', expiresAt: '2032-01-01T00:00:00Z' }],
  });
  assert.equal(rep.stats.superseded, 1);
  svc.reevaluateAll('cron', '2028-06-03T00:00:00Z');
  assert.equal(svc.evaluate(e.id, '2028-06-03T00:00:00Z').signable, true);
  assert.equal(svc.pendingNotifications(e.id).length, 1); // 旧的历史通知保留，不产生新通知
  assert.equal(svc.verifyAudit(), null);
});
