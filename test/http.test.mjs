import test from 'node:test';
import assert from 'node:assert/strict';
import { ComplianceService } from '../src/domain/service.mjs';
import { JsonStore } from '../src/domain/store.mjs';
import { createHandler } from '../src/http/app.mjs';

function setup() {
  const svc = new ComplianceService(new JsonStore(':memory:'));
  const handler = createHandler(svc);
  svc.addCountry({ code: 'DE', name: '德国' });
  svc.registerRole({ key: 'legal', name: '法务' });
  svc.publishRulebook({
    publishedBy: 'ops',
    activities: [{ key: 'sales', name: '销售', materials: [{ key: 'license', name: '许可', ownerRole: 'legal' }] }],
  });
  return { svc, handler };
}

async function call(handler, method, path, body, headers = {}) {
  const req = new Request(`http://local${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await handler(req);
  const json = await res.json();
  return { status: res.status, json };
}

test('HTTP 主干：健康检查、建模、阻断、422 放行拒绝、补齐后放行、审计校验', async () => {
  const { handler } = setup();

  let r = await call(handler, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');

  r = await call(handler, 'POST', '/entities', { name: '德国销售', countryCode: 'DE', timeZone: 'Europe/Berlin' }, { 'x-actor': 'biz' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const entityId = r.json.id;

  r = await call(handler, 'POST', `/entities/${entityId}/enrollments`, { activityKey: 'sales' });
  assert.equal(r.status, 200);

  r = await call(handler, 'GET', `/entities/${entityId}/status`);
  assert.equal(r.json.signable, false);
  assert.equal(r.json.blockers[0].materialKey, 'sales.license');

  // 阻断时先同步出 open 任务
  r = await call(handler, 'POST', `/entities/${entityId}/tasks/sync`, {});
  assert.equal(r.json.created.length, 1);

  // 未满足前置就开审查并尝试完成 -> 422
  r = await call(handler, 'POST', `/entities/${entityId}/reviews`, { timeZone: 'Asia/Singapore' }, { 'x-actor': 'legal-sg' });
  assert.equal(r.status, 200);
  const reviewId = r.json.id;
  assert.equal(r.json.openedFromTimeZone, 'Asia/Singapore');

  r = await call(handler, 'POST', `/reviews/${reviewId}/complete`, {}, { 'x-actor': 'legal-sg' });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'PRECONDITIONS_UNMET');
  assert.equal(r.json.error.details.blockers[0].materialKey, 'sales.license');

  // 合同来源导入证据（x-actor 透传为 importedBy），同步任务后放行
  r = await call(handler, 'POST', `/entities/${entityId}/evidence/imports`, {
    source: 'contract',
    items: [{ activityKey: 'sales', materialKey: 'license', documentRef: 'LIC-1', expiresAt: '2030-01-01T00:00:00Z' }],
  }, { 'x-actor': 'legal-berlin' });
  assert.equal(r.json.stats.added, 1);

  r = await call(handler, 'POST', `/entities/${entityId}/tasks/sync`, {});
  assert.equal(r.json.resolved.length, 1);

  r = await call(handler, 'POST', `/reviews/${reviewId}/complete`, { note: '通过' }, { 'x-actor': 'legal-sg' });
  assert.equal(r.status, 200);
  assert.equal(r.json.evaluation.signable, true);

  // 审查视图含阻断核对与审计时间线；链完整
  r = await call(handler, 'GET', `/reviews/${reviewId}`);
  assert.ok(Array.isArray(r.json.timeline));
  assert.ok(r.json.timeline.some((e) => e.action === 'review.complete.approved'));

  r = await call(handler, 'GET', '/audit/verify');
  assert.equal(r.json.intact, true);

  // 时间线按 UTC 记录，且能看到两位跨时区法务的操作
  const actors = r.json && (await call(handler, 'GET', `/entities/${entityId}/audit`)).json.map((e) => e.actor);
  assert.ok(actors.includes('legal-sg'));
  assert.ok(actors.includes('legal-berlin'));
});

test('HTTP 错误与版本通知：错误 JSON 400、未知路由 404、发版通知按实体送达', async () => {
  const { handler, svc } = setup();
  const e = svc.createEntity({ name: 'DE2', countryCode: 'DE' });
  svc.enrollActivity(e.id, { activityKey: 'sales' });

  const bad = await handler(new Request('http://local/entities', { method: 'POST', body: '{bad', headers: { 'content-type': 'application/json' } }));
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'BAD_JSON');

  const nf = await call(handler, 'GET', '/nope');
  assert.equal(nf.status, 404);

  // v2 增加材料 -> 一条针对该实体的通知
  const pub = await call(handler, 'POST', '/rulebooks', {
    note: '新增材料',
    activities: [{
      key: 'sales', name: '销售',
      materials: [
        { key: 'license', name: '许可', ownerRole: 'legal' },
        { key: 'registration', name: '备案', ownerRole: 'legal' },
      ],
    }],
  }, { 'x-actor': 'ops' });
  assert.equal(pub.status, 200);
  assert.equal(pub.json.version, 2);

  const list = await call(handler, 'GET', '/notifications');
  assert.equal(list.status, 200);
  assert.equal(list.json.length, 1);
  assert.equal(list.json[0].entityId, e.id);
  assert.deepEqual(list.json[0].payload.activities[0].changes.added, ['sales.registration']);

  const delivered = await call(handler, 'POST', `/notifications/${list.json[0].id}/delivered`);
  assert.equal(delivered.json.status, 'delivered');
  assert.equal((await call(handler, 'GET', '/notifications')).json.length, 0);

  // 版本列表保留两版
  const versions = await call(handler, 'GET', '/rulebooks');
  assert.deepEqual(versions.json.map((v) => v.version), [1, 2]);
});
