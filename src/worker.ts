import type { Job, Store } from './store.ts';

export type Handler = (job: Job) => Promise<void>;

// Example handler only: replace with your own idempotent business operation.
export const demoHandler: Handler = async (job) => {
  await new Promise(resolve => setTimeout(resolve, 150));
  if (job.type === 'demo.poison') throw new Error('Demo: downstream permanently rejected this event');
  if (job.type === 'demo.flaky' && job.attempts <= 2) throw new Error('Demo: downstream temporarily unavailable');
};

export async function tick(store: Store, handler: Handler): Promise<boolean> {
  const job = store.claim();
  if (!job) return false;
  let failure: string | undefined;
  try { await handler(job); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  store.finish(job.id, job.lease_token!, failure);
  return true;
}

export function startWorker(store: Store, handler: Handler) {
  let stopping = false;
  const done = (async () => {
    while (!stopping) {
      try {
        if (!await tick(store, handler)) await new Promise(resolve => setTimeout(resolve, 250));
      } catch (error) {
        console.error('Worker storage error:', error);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  })();
  return async () => { stopping = true; await done; };
}
