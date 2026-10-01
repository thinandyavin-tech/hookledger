import { createHmac, timingSafeEqual } from 'node:crypto';

export function equalSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Bind the event ID too: a captured signature cannot be reused with a new ID.
export function sign(secret: string, id: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${id}.${timestamp}.${body}`).digest('hex');
}

export function verify(secret: string, id: string, timestamp: string, body: string,
  signature: string, now = Date.now()): boolean {
  if (!/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  return equalSecret(sign(secret, id, timestamp, body), signature);
}
