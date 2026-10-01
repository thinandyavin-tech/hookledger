import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.ts';
import { tick } from '../src/worker.ts';

test('duplicate delivery is idempotent; changed bytes under the same ID conflict', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  assert.equal(store.enqueue('one', 'order.created', '{"data":1}', 0), 'accepted');
  assert.equal(store.enqueue('one', 'order.created', '{"data":1}', 1), 'duplicate');
  assert.equal(store.enqueue('one', 'order.created', '{"data":2}', 2), 'conflict');
  assert.equal(store.list().length, 1);
  assert.equal(store.history('one').length, 1);
});

test('committed work survives reopening and two connections do not claim the same live lease', t => {
  const folder = mkdtempSync(join(tmpdir(), 'hookledger-'));
  const path = join(folder, 'queue.db');
  const first = new Store(path);
  first.enqueue('one', 'order', '{}', 0); first.close();
  const a = new Store(path), b = new Store(path);
  t.after(() => { a.close(); b.close(); rmSync(folder, { recursive: true, force: true }); });
  assert.equal(a.get('one')?.status, 'queued');
  const job = a.claim(100, 1000)!;
  assert.equal(job.id, 'one');
  assert.equal(b.claim(101, 1000), undefined);
  assert.equal(b.get('one')?.lease_token, job.lease_token);
});

test('expired work is reclaimed; a stale worker cannot complete or fail the new lease', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.enqueue('one', 'order', '{}', 0);
  const old = store.claim(0, 100)!;
  assert.equal(store.finish('one', old.lease_token!, undefined, 100), false);
  const fresh = store.claim(100, 100)!;
  assert.notEqual(old.lease_token, fresh.lease_token);
  assert.equal(fresh.attempts, 2);
  assert.equal(store.finish('one', old.lease_token!, 'old failure', 101), false);
  assert.equal(store.finish('one', fresh.lease_token!, undefined, 101), true);
  assert.equal(store.get('one')?.status, 'succeeded');
});

test('backoff enforces due time, attempt limit parks poison events, redrive preserves history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.enqueue('one', 'order', '{}', 0);
  let job = store.claim(0)!;
  store.finish(job.id, job.lease_token!, 'unavailable', 1);
  assert.equal(store.claim(1000), undefined);
  job = store.claim(1001)!;
  store.finish(job.id, job.lease_token!, 'unavailable', 1002);
  assert.equal(store.claim(3001), undefined);
  job = store.claim(3002)!;
  store.finish(job.id, job.lease_token!, 'poison', 3003);
  assert.equal(store.get('one')?.status, 'dead');
  assert.equal(store.claim(99999), undefined);
  const historyLength = store.history('one').length;
  assert.equal(store.retry('one', 100000), true);
  assert.equal(store.retry('one', 100000), false);
  assert.equal(store.get('one')?.attempts, 0);
  assert.equal(store.history('one').length, historyLength + 1);
  assert.equal(store.claim(100000)?.attempts, 1);
});

test('a crash on the final attempt transitions to dead instead of staying processing', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.enqueue('one', 'order', '{}', 0);
  store.claim(0, 10); store.claim(10, 10); store.claim(20, 10);
  assert.equal(store.claim(30, 10), undefined);
  assert.equal(store.get('one')?.status, 'dead');
  assert.match(store.get('one')!.error!, /final attempt/);
});

test('failed transaction rolls back both event and history', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.db.exec(`CREATE TRIGGER reject_history BEFORE INSERT ON history BEGIN SELECT RAISE(ABORT, 'test failure'); END;`);
  assert.throws(() => store.enqueue('one', 'order', '{}'), /test failure/);
  assert.equal(store.get('one'), undefined);
});

test('worker records actual handler outcome and leaves no live lease', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.enqueue('one', 'order', '{}');
  await tick(store, async () => {});
  assert.equal(store.get('one')?.status, 'succeeded');
  assert.equal(store.get('one')?.lease_token, null);
  store.enqueue('two', 'order', '{}');
  await tick(store, async () => { throw new Error('downstream offline'); });
  assert.equal(store.get('two')?.status, 'queued');
  assert.equal(store.get('two')?.error, 'downstream offline');
});
