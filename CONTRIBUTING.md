# Contributing

Use Node.js 24.12+ (24.x). Run `npm ci`, `npm run check`, and `npm test` before proposing a change.

For a bug, include the input, expected behavior, actual behavior, and a minimal reproduction. Never include `.env` files, credentials, or customer payloads. Changes to queue behavior should include a regression test covering the failure boundary. Keep unrelated refactors separate.

For a larger feature, describe the real use case and its tradeoffs before building it. The project intentionally targets a single host and modest traffic.
