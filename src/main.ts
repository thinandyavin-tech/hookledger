import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Store } from './store.ts';
import { makeServer } from './server.ts';
import { demoHandler, startWorker } from './worker.ts';

const webhookSecret = process.env.WEBHOOK_SECRET ?? '';
const adminToken = process.env.ADMIN_TOKEN ?? '';
if (webhookSecret.length < 32 || adminToken.length < 32 || webhookSecret === adminToken) {
  throw new Error('Set distinct WEBHOOK_SECRET and ADMIN_TOKEN values of at least 32 characters. Run npm run setup.');
}
const path = process.env.DATABASE_PATH ?? 'data/hookledger.db';
mkdirSync(dirname(path), { recursive: true });
const store = new Store(path);
const server = makeServer(store, { webhookSecret, adminToken });
const port = Number(process.env.PORT ?? 4310);
const host = process.env.HOST ?? '127.0.0.1';
server.listen(port, host, () => {
  console.log(`HookLedger: http://${host}:${port}`);
  console.log('Demo handler active. Use ADMIN_TOKEN from .env to unlock the dashboard.');
});
const stopWorker = startWorker(store, demoHandler);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('Draining requests and current handler...');
  const closed = new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all([closed, stopWorker()]);
  store.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
