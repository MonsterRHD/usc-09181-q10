import { createServer } from 'node:http';
import { ComplianceService } from './domain/compliance-service.mjs';
import { createApp } from './http/app.mjs';

const DATA_FILE = process.env.COMPLIANCE_LOG || './data/compliance.jsonl';
const PORT = process.env.PORT || 3000;

const service = new ComplianceService({ file: DATA_FILE });
await service.start();

const app = createApp(service);
const server = createServer(app);

function shutdown() {
  server.close(async () => {
    await service.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  console.log(`企业出海合规清单服务已启动: http://localhost:${PORT} (事件日志 ${DATA_FILE})`);
});
