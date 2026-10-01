# Design decisions

## Why an inbox?

A webhook request should not wait for downstream work to finish. The receiver's responsibility is to verify the sender and durably record accepted work. Returning `202` only after commit gives the sender a clear boundary: before that response, it can safely retry the same ID and body.

The motivating use case is small commerce and automation integrations: an order webhook arrives twice, a receipt processor is temporarily unavailable, or a worker restarts halfway through a job. The demo uses synthetic order/receipt/inventory events and makes no claim of a live commerce integration.

## Why SQLite and no message broker?

For a single host, SQLite can hold both the queue and audit trail in one transaction. This keeps a runnable example small and removes the dual-write problem between an application database and a broker. WAL allows readers alongside a writer; `BEGIN IMMEDIATE` serializes claim transactions. `synchronous=FULL` requests durable commits subject to SQLite, the operating system, and storage hardware honoring their guarantees.

The tradeoff is synchronous I/O and a single writer. This design is not a distributed queue. Moving to multiple hosts would require a shared transactional store or a durable broker and a redesigned ownership model. Do not put the SQLite file on a network filesystem.

## Why a lease token?

Imagine worker A claims an event, pauses, and misses its deadline. Worker B reclaims the event. A then wakes up and reports success. Without a fencing token, A can overwrite B's state.

Every claim issues a new random token. Completion runs inside a transaction and checks the token, status, and deadline. A stale or expired lease changes nothing. Expiry on the final attempt moves the event to `dead` on the next claim pass, so repeated crashes cannot create an immortal processing row.

This protects **the inbox state only**. It cannot cancel a network request that worker A already sent. The external service must enforce idempotency using the stable event ID. A handler that never returns also blocks this process's serial worker loop; another process sharing the same local database can reclaim expired work, but this starter does not supervise handlers or automatically spawn workers.

## Why hash raw bytes?

An event ID identifies one immutable message. Repeating the same bytes is a normal retry; reusing the ID with a changed body is a conflict. Hashing raw bytes avoids ambiguous JSON canonicalization. The consequence is deliberate: reformatting identical JSON under the same ID produces a conflict.

The HMAC also includes the event ID, so a valid signature cannot be copied onto a new ID to evade deduplication. The signed timestamp limits how long captured requests remain acceptable. Replays within that window still hit the unique-ID check. Event IDs are retained indefinitely in this version; deleting them would shorten the deduplication horizon.

## Why an audit trail?

Current state answers "where is this event?" History answers "how did it get here?" State changes and history inserts share a transaction. Redrive resets the attempt counter but retains previous transitions. This makes a new recovery cycle explicit without pretending old failures never happened.

## Failure table

| Failure point | Expected recovery |
| --- | --- |
| Before commit | No acknowledgement; sender retries |
| After commit, before response | Sender retries; same ID/body returns duplicate |
| After claim, before handler completes | Lease expires; another claim consumes the next attempt |
| After remote side effect, before completion | Work may run again; remote idempotency is required |
| Old worker completes after reclaim | Stale token rejected |
| Final attempt crashes | Next claim pass parks event as dead |
| Audit insert fails | Entire state transaction rolls back |
| Disk fills or SQLite write fails | API returns `500`; sender must retry |

## Next improvements driven by a real deployment

Before adding complexity, measure an actual workload. Possible follow-ups include handler deadlines and supervision, bounded retention with a separate dedupe horizon, jittered retries, signing-key rotation, payload encryption, a backup/restore drill, and an integration adapter for one real webhook provider. None of those capabilities are claimed by this version.
