import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/store.ts';
import { makeServer } from '../src/server.ts';
import { sign, verify } from '../src/auth.ts';

const secret = 'webhook-test-secret-with-32-characters';
const admin = 'admin-test-secret-with-32-characters';
async function setup(t: TestContext) {
  const store = new Store(':memory:');
  const server = makeServer(store, { webhookSecret: secret, adminToken: admin });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (id: string, raw: string, overrides: Record<string, string> = {}) => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    return fetch(`${base}/v1/events`, { method: 'POST', headers: {
      'content-type': 'application/json', 'x-webhook-id': id, 'x-webhook-timestamp': timestamp,
      'x-webhook-signature': sign(secret, id, timestamp, raw), ...overrides,
    }, body: raw });
  };
  return { store, base, post };
}

test('HTTP: signed delivery -> durable acceptance -> duplicate -> conflict', async t => {
  const { store, post } = await setup(t);
  const raw = JSON.stringify({ type: 'order.created', data: { amount: 250 } });
  assert.equal((await post('event1', raw)).status, 202);
  assert.equal(store.get('event1')?.payload, raw);
  assert.equal((await post('event1', raw)).status, 200);
  assert.equal((await post('event1', raw.replace('250', '300'))).status, 409);
});

test('HTTP: rejects tampered signatures, expired timestamps, and ID substitution', async t => {
  const { store, post } = await setup(t);
  const raw = '{"type":"order","data":{}}';
  assert.equal((await post('a', raw, { 'x-webhook-signature': '0'.repeat(64) })).status, 401);
  const ts = String(Math.floor(Date.now() / 1000) - 301);
  assert.equal((await post('a', raw, { 'x-webhook-timestamp': ts, 'x-webhook-signature': sign(secret, 'a', ts, raw) })).status, 401);
  const current = String(Math.floor(Date.now() / 1000));
  assert.equal((await post('b', raw, { 'x-webhook-timestamp': current, 'x-webhook-signature': sign(secret, 'a', current, raw) })).status, 401);
  assert.equal(store.list().length, 0);
});

test('signature binds raw bytes and rejects future timestamps', () => {
  const raw = '{"data":1}'; const ts = '1700000000';
  const signature = sign(secret, 'a', ts, raw);
  assert.equal(verify(secret, 'a', ts, raw, signature, 1700000000000), true);
  assert.equal(verify(secret, 'a', ts, raw + ' ', signature, 1700000000000), false);
  assert.equal(verify(secret, 'a', ts, raw, signature, 1699999600000), false);
});

test('HTTP: validates JSON, schema, content type, and 64 KiB limit', async t => {
  const { store, post } = await setup(t);
  assert.equal((await post('a', '{')).status, 400);
  assert.equal((await post('a', '{"type":"order"}')).status, 400);
  assert.equal((await post('a', '{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post('a', 'x'.repeat(65537))).status, 413);
  assert.equal(store.list().length, 0);
});

test('HTTP: admin reads and redrive require a token; non-dead events cannot be redriven', async t => {
  const { store, base, post } = await setup(t);
  await post('a', '{"type":"order","data":{}}');
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
  assert.equal((await fetch(`${base}/api/jobs/a/retry`, { method: 'POST' })).status, 401);
  const headers = { Authorization: `Bearer ${admin}` };
  const result = await fetch(`${base}/api/jobs`, { headers });
  assert.equal(result.status, 200);
  const data = await result.json();
  assert.equal(data.jobs[0].payload, undefined);
  assert.equal(data.jobs[0].lease_token, undefined);
  assert.equal((await fetch(`${base}/api/jobs/a/retry`, { method: 'POST', headers })).status, 409);
  store.db.prepare("UPDATE jobs SET status='dead' WHERE id='a'").run();
  assert.equal((await fetch(`${base}/api/jobs/a/retry`, { method: 'POST', headers })).status, 200);
  assert.equal(store.get('a')?.status, 'queued');
});

test('HTTP: dashboard uses CSP, serves only allowlisted assets, and health is available', async t => {
  const { base } = await setup(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.match(await response.text(), /Every event. Accounted for/);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});
