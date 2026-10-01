import { randomUUID } from 'node:crypto';
import { sign } from '../src/auth.ts';

const secret = process.env.WEBHOOK_SECRET;
if (!secret) throw new Error('Run npm run setup first');
const base = `http://127.0.0.1:${process.env.PORT ?? 4310}`;
const run = randomUUID().slice(0, 8);
const cases = [
  ['order', 'order.created'], ['receipt', 'receipt.received'], ['inventory', 'inventory.updated'],
  ['retry', 'demo.flaky'], ['poison', 'demo.poison'],
];
async function send(id: string, type: string, invalid = false) {
  const raw = JSON.stringify({ type, data: { reference: 'DEMO-1024', amount: 250, currency: 'THB' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const response = await fetch(`${base}/v1/events`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-webhook-id': id, 'x-webhook-timestamp': ts,
    'x-webhook-signature': invalid ? '0'.repeat(64) : sign(secret!, id, ts, raw),
  }, body: raw });
  console.log(`${response.status} ${await response.text()}`);
}
for (const [name, type] of cases) await send(`${run}-${name}`, type);
await send(`${run}-order`, 'order.created');
await send(`${run}-order`, 'order.changed');
await send(`${run}-tampered`, 'order.created', true);
console.log('Expected: 5 accepted, 1 duplicate, 1 conflict, 1 rejected signature.');
console.log('After ~5 seconds: 4 succeeded and 1 dead. Open the dashboard to inspect attempt history.');
