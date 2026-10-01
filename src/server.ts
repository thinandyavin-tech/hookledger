import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { equalSecret, verify } from './auth.ts';
import type { Store } from './store.ts';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const MAX_BODY = 64 * 1024;
class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<string> {
  if (Number(req.headers['content-length']) > MAX_BODY) throw new HttpError(413, 'Body limit is 64 KiB');
  const chunks: Buffer[] = [];
  let size = 0;
  // Do not destroy the socket on early exit: the client must receive the 413 response.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Body limit is 64 KiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function header(req: IncomingMessage, key: string): string {
  const value = req.headers[key];
  return typeof value === 'string' ? value : '';
}

export function makeServer(store: Store, config: { webhookSecret: string; adminToken: string }) {
  return createServer({ requestTimeout: 10_000, headersTimeout: 10_000 }, async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const [file, type] = assets.get(path)!;
        res.writeHead(200, { 'Content-Type': type });
        return res.end(readFileSync(new URL(`../public/${file}`, import.meta.url)));
      }
      if (req.method === 'GET' && path === '/health') return json(res, 200, { status: 'ok' });
      if (req.method === 'POST' && path === '/v1/events') {
        if (header(req, 'content-type').split(';')[0].trim() !== 'application/json') throw new HttpError(415, 'Use application/json');
        const id = header(req, 'x-webhook-id');
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new HttpError(400, 'Invalid event ID');
        const raw = await body(req);
        if (!verify(config.webhookSecret, id, header(req, 'x-webhook-timestamp'), raw,
          header(req, 'x-webhook-signature'))) throw new HttpError(401, 'Invalid or expired signature');
        let event;
        try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
        if (!event || typeof event !== 'object' || typeof event.type !== 'string' ||
          !/^[a-zA-Z0-9_.-]{1,80}$/.test(event.type) || !Object.hasOwn(event, 'data')) {
          throw new HttpError(400, 'Expected {type: string, data: ...}');
        }
        const outcome = store.enqueue(id, event.type, raw);
        return json(res, outcome === 'accepted' ? 202 : outcome === 'duplicate' ? 200 : 409, { id, outcome });
      }
      if (path.startsWith('/api/')) {
        if (!equalSecret(header(req, 'authorization'), `Bearer ${config.adminToken}`)) throw new HttpError(401, 'Admin token required');
        if (req.method === 'GET' && path === '/api/jobs') return json(res, 200, { jobs: store.list(), stats: store.stats() });
        const match = /^\/api\/jobs\/([a-zA-Z0-9_-]{1,128})\/(history|retry)$/.exec(path);
        if (match && req.method === 'GET' && match[2] === 'history') {
          if (!store.get(match[1])) throw new HttpError(404, 'Event not found');
          return json(res, 200, { history: store.history(match[1]) });
        }
        if (match && req.method === 'POST' && match[2] === 'retry') {
          if (!store.retry(match[1])) throw new HttpError(409, 'Only dead events can be retried');
          return json(res, 200, { outcome: 'queued' });
        }
      }
      throw new HttpError(404, 'Not found');
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status === 413) { res.setHeader('Connection', 'close'); req.resume(); }
        return json(res, error.status, { error: error.message });
      }
      console.error('Request failed:', error);
      json(res, 500, { error: 'Internal server error' });
    }
  });
}
