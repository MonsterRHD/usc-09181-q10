import { createServer } from 'node:http';
import { ComplianceService } from './domain/service.mjs';
import { createHandler } from './http/app.mjs';

// 状态默认落在 data/state.json，可用 STATE_FILE 覆盖；重启后从该文件接续人工核查。
const stateFile = process.env.STATE_FILE || new URL('../data/state.json', import.meta.url);
const service = new ComplianceService(stateFile);
const handler = createHandler(service);

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const webReq = new Request(`http://${req.headers.host || 'local'}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: bodyText || undefined,
    });
    try {
      const webRes = await handler(webReq);
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers));
      res.end(Buffer.from(await webRes.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'INTERNAL', message: err.message } }));
    }
  });
  req.on('error', () => { res.writeHead(400); res.end(); });
});

server.listen(process.env.PORT || 3000);

export { server, service };
