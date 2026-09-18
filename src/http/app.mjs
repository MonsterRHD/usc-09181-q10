import { DomainError, ERR } from '../domain/errors.mjs';

const STATUS_BY_CODE = {
  [ERR.NOT_FOUND]: 404,
  [ERR.VALIDATION]: 400,
  [ERR.UNKNOWN_REQUIREMENT]: 400,
  [ERR.DUPLICATE]: 409,
  [ERR.CONFLICT]: 409,
  [ERR.PREREQUISITES_NOT_MET]: 422,
  [ERR.CONCURRENT_MODIFICATION]: 409,
};

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new DomainError(ERR.VALIDATION, '请求体不是合法 JSON');
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function actorOf(req) {
  return req.headers['x-actor']?.toString() || 'system';
}

/**
 * 路由约定：
 * 管理资料  POST /admin/{countries|activities|roles}
 * 实体      POST /entities
 * 规则      POST /countries/:countryId/rules/publish  GET /countries/:countryId/rules
 * 证据      POST /entities/:id/evidence/imports       GET /entities/:id/evidence/:code/history
 * 豁免      POST /entities/:id/exemptions             POST /entities/:id/exemptions/:code/revocations
 * 核查      POST /entities/:id/reviews                POST /entities/:id/opening-review/completions
 * 查询      GET /entities/:id/status|blocking-reasons|audit|notifications
 */
export function createApp(service) {
  return async function app(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname.split('/').filter(Boolean);
    const actor = actorOf(req);
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { status: 'ok' });

      // ---------- 管理资料 ----------
      if (req.method === 'POST' && p[0] === 'admin' && p[1] === 'countries') {
        const body = await readJson(req);
        const rec = await service.registerCountry(body, actor);
        return send(res, 201, { id: rec.data.id });
      }
      if (req.method === 'POST' && p[0] === 'admin' && p[1] === 'activities') {
        const body = await readJson(req);
        const rec = await service.registerActivity(body, actor);
        return send(res, 201, { id: `${rec.data.countryId}:${rec.data.code}` });
      }
      if (req.method === 'POST' && p[0] === 'admin' && p[1] === 'roles') {
        const body = await readJson(req);
        const rec = await service.registerRole(body, actor);
        return send(res, 201, { code: rec.data.code });
      }

      // ---------- 实体 ----------
      if (req.method === 'POST' && p[0] === 'entities' && p.length === 1) {
        const body = await readJson(req);
        const id = await service.onboardEntity(body, actor);
        return send(res, 201, { id });
      }

      // ---------- 规则 ----------
      if (req.method === 'POST' && p[0] === 'countries' && p[2] === 'rules') {
        const body = await readJson(req);
        const result = await service.publishRules(
          p[1],
          body.specs,
          { actor, effectiveFrom: body.effectiveFrom ?? null },
        );
        return send(res, 201, { version: result.version, publishedAt: result.publishedAt, diff: result.diff });
      }
      if (req.method === 'GET' && p[0] === 'countries' && p[2] === 'rules') {
        return send(res, 200, { versions: service.ruleVersions(p[1]) });
      }

      // ---------- 实体子资源 ----------
      if (p[0] === 'entities' && p[1]) {
        const entityId = p[1];

        if (req.method === 'POST' && p[2] === 'evidence' && p[3] === 'imports') {
          const body = await readJson(req);
          const result = await service.importEvidence({ entityId, ...body }, actor);
          return send(res, 201, result);
        }
        if (req.method === 'GET' && p[2] === 'evidence' && p[4] === 'history') {
          return send(res, 200, { history: service.evidenceHistory(entityId, p[3]) });
        }
        if (req.method === 'POST' && p[2] === 'exemptions' && p.length === 3) {
          const body = await readJson(req);
          const rec = await service.grantExemption({ entityId, ...body }, actor);
          return send(res, 201, { code: rec.data.code, status: 'GRANTED' });
        }
        if (req.method === 'POST' && p[2] === 'exemptions' && p[4] === 'revocations') {
          const body = await readJson(req);
          const rec = await service.revokeExemption(
            { entityId, code: p[3], ...body },
            actor,
          );
          return send(res, 200, { code: rec.data.code, status: 'REVOKED', revokedAt: rec.data.revokedAt });
        }
        if (req.method === 'POST' && p[2] === 'reviews' && p.length === 3) {
          const body = await readJson(req);
          const rec = await service.recordReview({ entityId, ...body }, actor);
          return send(res, 201, { code: rec.data.code, decision: rec.data.decision });
        }
        if (req.method === 'POST' && p[2] === 'opening-review' && p[3] === 'completions') {
          const body = await readJson(req);
          const result = await service.completeOpeningReview(
            { entityId, ...body },
            actor,
          );
          return send(res, 200, result);
        }
        if (req.method === 'GET' && p[2] === 'status') {
          return send(res, 200, service.entityStatus(entityId, url.searchParams.get('at')));
        }
        if (req.method === 'GET' && p[2] === 'blocking-reasons') {
          return send(res, 200, { blockers: service.blockingReasons(entityId, url.searchParams.get('at')) });
        }
        if (req.method === 'GET' && p[2] === 'audit') {
          return send(
            res,
            200,
            {
              timeline: service.auditTimeline(entityId, {
                types: url.searchParams.get('types')?.split(',').filter(Boolean) ?? null,
                from: url.searchParams.get('from'),
                to: url.searchParams.get('to'),
              }),
            },
          );
        }
        if (req.method === 'GET' && p[2] === 'notifications') {
          return send(res, 200, { notifications: service.notifications(entityId) });
        }
        if (req.method === 'POST' && p[2] === 'notifications' && p[4] === 'read') {
          await service.markNotificationRead({ entityId, notificationId: p[3] }, actor);
          return send(res, 200, { read: true });
        }
      }

      return send(res, 404, { error: 'NOT_FOUND', message: '未知路由' });
    } catch (err) {
      if (err instanceof DomainError) {
        return send(res, STATUS_BY_CODE[err.code] ?? 400, {
          error: err.code,
          message: err.message,
          details: err.details,
        });
      }
      console.error(err);
      return send(res, 500, { error: 'INTERNAL', message: err.message });
    }
  };
}
