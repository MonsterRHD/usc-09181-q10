import { DomainError } from '../domain/errors.mjs';

/**
 * Web 标准 Request/Response 处理器，便于 node:http 与测试共用。
 * 调用方身份与所在时区由请求头带入：x-actor / x-timezone。
 */
export function createHandler(service) {
  return async function handler(req) {
    const url = new URL(req.url, 'http://local');
    const actor = req.headers.get('x-actor') || 'system';
    try {
      const body = req.method === 'GET' || req.method === 'DELETE' ? null : await readJson(req);
      const route = match(req.method, url.pathname);
      if (!route) return json(404, { error: { code: 'NOT_FOUND', message: `无此路由: ${req.method} ${url.pathname}` } });
      const ctx = { service, body: body || {}, query: url.searchParams, actor };
      return json(200, await route.run(ctx, route.params));
    } catch (err) {
      if (err instanceof DomainError) {
        return json(err.status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      return json(500, { error: { code: 'INTERNAL', message: err.message } });
    }
  };
}

async function readJson(req) {
  const text = await req.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError(400, 'BAD_JSON', '请求体不是合法 JSON');
  }
}

function json(status, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const routes = [];
const on = (method, pattern, run) => routes.push({ method, pattern, run });

function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = matchPattern(r.pattern, pathname);
    if (params) return { ...r, params };
  }
  return null;
}

function matchPattern(pattern, pathname) {
  const a = pattern.split('/').filter(Boolean);
  const b = pathname.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

/* ---------------- 路由表 ---------------- */

on('GET', '/health', () => ({ status: 'ok' }));

on('POST', '/admin/countries', ({ service, body, actor }) => service.addCountry(body, actor));
on('POST', '/admin/roles', ({ service, body, actor }) => service.registerRole(body, actor));
on('GET', '/countries', ({ service }) => service.state.countries);
on('GET', '/roles', ({ service }) => service.state.roles);

on('POST', '/entities', ({ service, body, actor }) => service.createEntity(body, actor));
on('GET', '/entities', ({ service }) => service.state.entities);
on('GET', '/entities/:id', ({ service }, { id }) => {
  const entity = service.state.entities.find((e) => e.id === id);
  if (!entity) throw new DomainError(404, 'ENTITY_NOT_FOUND', `实体不存在: ${id}`);
  return entity;
});
on('POST', '/entities/:id/enrollments', ({ service, body, actor }, { id }) => service.enrollActivity(id, body, actor));
on('POST', '/entities/:id/migrate', ({ service, body, actor }, { id }) => service.migrateEnrollment(id, body.activityKey, body.rulebookVersion, actor));
on('GET', '/entities/:id/status', ({ service, query }, { id }) => service.evaluate(id, query.get('at') || undefined));
on('GET', '/entities/:id/tasks', ({ service }, { id }) => service.listTasks(id));
on('POST', '/entities/:id/tasks/sync', ({ service, actor, query }, { id }) => service.syncTasks(id, actor, query.get('at') || undefined));

on('POST', '/entities/:id/evidence/imports', ({ service, body, actor }, { id }) =>
  service.importEvidence(id, { importedBy: actor, ...body }));
on('GET', '/entities/:id/evidence', ({ service }, { id }) =>
  service.state.evidence.filter((e) => e.entityId === id));
on('GET', '/entities/:id/imports', ({ service }, { id }) =>
  service.state.imports.filter((r) => r.entityId === id));

on('POST', '/entities/:id/exemptions', ({ service, body, actor }, { id }) =>
  service.grantExemption(id, { grantedBy: actor, ...body }));
on('POST', '/entities/:id/exemptions/:exId/revoke', ({ service, body, actor }, { id, exId }) =>
  service.revokeExemption(id, exId, { revokedBy: actor, ...body }));

on('POST', '/entities/:id/reviews', ({ service, body, actor, query }, { id }) =>
  service.openReview(id, { openedBy: actor, timeZone: body.timeZone || query.get('timeZone'), note: body.note }));
on('GET', '/reviews/:rid', ({ service }, { rid }) => service.reviewBundle(rid));
on('POST', '/reviews/:rid/blocker-checks', ({ service, body, actor }, { rid }) => service.checkBlocker(rid, body, actor));
on('POST', '/reviews/:rid/complete', ({ service, body, actor, query }, { rid }) => service.completeReview(rid, { actor, note: body.note, at: body.at || query.get('at') || undefined }));

on('POST', '/rulebooks', ({ service, body, actor }) => {
  const r = service.publishRulebook({ publishedBy: actor, ...body }, actor);
  return {
    version: r.rulebook.version,
    id: r.rulebook.id,
    effectiveFrom: r.rulebook.effectiveFrom,
    note: r.rulebook.note,
    previousVersion: r.previousVersion,
    changes: r.changes,
    notifications: r.notifications,
  };
});
on('GET', '/rulebooks', ({ service }) => service.listRulebooks());
on('GET', '/rulebooks/:version', ({ service }, { version }) => service.getRulebook(version));

on('GET', '/notifications', ({ service, query }) => service.pendingNotifications(query.get('entityId')));
on('POST', '/notifications/:nid/delivered', ({ service }, { nid }) => service.markNotificationDelivered(nid));

on('GET', '/entities/:id/audit', ({ service, query }, { id }) =>
  service.auditTimeline({ entityId: id, since: query.get('since') || null }));
on('GET', '/audit/verify', ({ service }) => {
  const broken = service.verifyAudit();
  return { intact: broken === null, broken };
});
on('POST', '/system/reevaluate', ({ service, actor, query }) => service.reevaluateAll(actor, query.get('at') || undefined));
