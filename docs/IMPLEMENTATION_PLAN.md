# 03 — Implementation Plan

Two days, six features. Each task has a definition-of-done so you know when to stop polishing and move on.

## Day 1 — Core engine

### Task 1.1: Project skeleton (30 min)
- `npm init`, install ioredis, express, vitest, supertest
- Set up the directory tree from README
- Add `npm run test`, `npm run test:watch`
- Spin up Redis locally (`docker run -p 6379:6379 redis:7-alpine`)
- Stub `src/index.js` exporting `createRateLimiter` and `createDebugRouter` as no-ops

**Done when:** `npm test` runs zero tests successfully.

### Task 1.2: Sliding window strategy (2-3 hr)

Implement `src/strategies/sliding-window.js`.

The Lua script (see `04-redis-schema.md` for the exact text):
1. Remove entries with scores older than `now - windowMs`
2. Get the current count via `ZCARD`
3. If count + cost > limit, return blocked
4. Otherwise add `cost` entries with score `now` (use unique members, see schema doc)
5. Return `{ allowed, count, limit, resetAt }`

Use `ioredis.defineCommand('slidingWindowCheck', { numberOfKeys: 1, lua: '...' })`.

**Done when:** unit tests pass — 100 requests with limit 100 → 100 allowed, 101st blocked. After windowMs, requests allowed again. Burst-then-trickle test passes.

### Task 1.3: Identifier chaining (1-2 hr)

Implement `src/identifiers/chain.js`.

- `resolveIdentifiers(req, config)` returns array of `{ type, value }`
- Built-in presets (ip, user, apiKey, session)
- Skip identifiers whose extractor returns null/undefined
- Each identifier gets its own Redis key (`rl:<type>:<value>`)

Wire it into the middleware: check all identifiers, return 429 if *any* one is over limit. Headers reflect the tightest one.

**Done when:** integration test with two identifiers (ip + user) shows that hitting the limit on user blocks even from a fresh IP.

### Task 1.4: Per-route cost weights (1 hr)

In `middleware.js`:
- Resolve cost from `routeCosts[method + ' ' + path]`, fall back to `routeCosts.default`, fall back to 1
- If `costResolver` is provided, use it instead
- Pass cost into the Lua script

**Done when:** A route configured with cost 10 hits the limit in 10 requests, while a route with cost 1 takes 100.

### End of Day 1 deliverable
A working middleware with sliding window, identifier chaining, and route cost weights. Tests passing. You can `npm install` it locally and protect a real Express app.

## Day 2 — Differentiators

### Task 2.1: Adaptive load monitor (2 hr)

Implement `src/adaptive/load-monitor.js`.

- Singleton class with `start()` and `stop()`
- Polls `process.cpuUsage()` every `pollIntervalMs`
- Computes CPU % over last interval (delta between samples)
- Returns load factor: `1.0` when CPU < threshold, scales linearly to `minFactor` at 100% CPU
- Exposes `getLoadFactor()` and `getMetrics()` (for the debug route)

In middleware, multiply `limit` by `loadFactor` before checking. Round, but never below 1 (otherwise nothing ever passes).

**Done when:** Test with a stubbed CPU usage shows limit drops correctly. Also: starting two middlewares doesn't double the polling.

### Task 2.2: Penalty scorer (2 hr)

Implement `src/penalty/scorer.js`.

Redis schema for penalty: a string key `rl:penalty:<type>:<value>` storing the current multiplier, with TTL = `decayMs`.

- `getMultiplier(redis, identifier)` → number (1.0 if no penalty key)
- `recordViolation(redis, identifier)` → increments by `incrementPerViolation`, caps at `maxMultiplier`, resets TTL

In middleware: when a request is blocked, call `recordViolation` for each over-limit identifier. When checking, fetch multiplier and divide limit by it.

**Critical:** `recordViolation` should be fire-and-forget (don't await it before sending the 429 response). But do log errors.

**Done when:** Test shows: 5 consecutive 429s for the same IP → multiplier reaches max → subsequent requests blocked at 1/4 of normal limit. After `decayMs` of no violations, multiplier returns to 1.

### Task 2.3: Inspection helpers and callback wiring (45 min)

Implement `src/inspection.js` exporting four functions (full signatures in `02-api-design.md`):

- `inspectIdentifier(redis, type, value, opts?)` — fetch full state for one identifier
- `listActiveIdentifiers(redis, opts?)` — paginated scan
- `getLoadMetrics()` — synchronous, reads from the load monitor singleton
- `resetIdentifier(redis, type, value, opts?)` — clear both window and penalty keys

These are plain async functions, not Express routers. Use `SCAN` for listing (never `KEYS`). Re-export from `src/index.js`.

Wire up the new callbacks in `middleware.js`:
- `onViolation` fires inside `penalty.recordViolation` when the multiplier actually changes
- `onDegraded` fires when a Redis call fails and we fail open
- `onAllowed` fires after a successful check (document the perf cost in the API doc)

All callbacks must be wrapped in try/catch — a user's broken callback shouldn't crash the middleware.

**Done when:** Inspection unit tests pass (seed Redis with known data, assert the helpers return it). Integration test verifies each callback fires with the right shape.

### Task 2.4: Demo dashboard example app (1-1.5 hr)

A portfolio/showcase app that lets you watch the library's features play out interactively — no auth, no admin tooling.

- `examples/demo/server.js` — Express app on port 3001. Three demo endpoints all behind `createRateLimiter`:
  - `windowMs: 10_000`, `limit: 20`, `adaptive: { enabled: true, cpuThreshold: 60, minFactor: 0.3 }`, `identifiers: ['ip']`
  - `GET /api/ping` → cost 1 (lightweight)
  - `GET /api/search` → cost 5 (medium, simulates a DB query with a short delay)
  - `GET /api/crunch` → cost 10, runs a synchronous CPU-burning loop (sum primes to 50 000) so the load monitor actually reacts
  - `GET /api/status` → unauthenticated, returns `getLoadMetrics()`
  - All rate-limit headers (`RateLimit-Remaining`, `RateLimit-Limit`, `RateLimit-Reset`, `RateLimit-Policy`) flow through from the middleware
- `examples/demo/public/index.html` — React 18 + Tailwind CDN, light theme, no login prompt.
  - Three endpoint cards side by side, each with: name, cost badge, Send button, last-response status pill (green/red), remaining-quota progress bar, log of last 5 responses
  - Global status bar at top: load factor (colour-coded), CPU % bar, effective limit (`floor(20 × loadFactor)`), polls `/api/status` every 2 s
  - Clicking a card button fires one fetch, reads response headers, updates that card — no auto-polling
  - 429 cards show "Rate limited — resets in Xs" from `RateLimit-Reset`
- `examples/demo/README.md` — what it demos, how to run, how to trigger adaptive load reduction (spam the crunch button)

Use Tailwind CSS and React for the front-end. Light-themed color palette. One theme only.

**Feature done when:** A react component or a hook or any atomic feature like these are completed.
The front-end should not be tested as the back-end covers the integration tests.

**Done when:** Running `npm start` in `examples/demo/` boots on port 3001, visiting `localhost:3001` shows three cards with no login prompt, clicking crunch repeatedly causes the load factor to drop and the effective limit to decrease.

### Task 2.5: Documentation, types, and ship prep (1 hr)

- Update top-level README with install instructions, kitchen-sink example, and a link to `examples/admin-dashboard/`
- Write `src/index.d.ts` with the full type definitions (see `02-api-design.md`)
- Add `tsc --noEmit --checkJs` to a `typecheck` script and verify it passes

**Done when:** A new developer can clone, `npm install`, run `node examples/admin-dashboard/server.js`, and see everything work. `npm run typecheck` passes.
