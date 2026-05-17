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

### Task 2.3: Debug dashboard route (1-2 hr)

Implement `src/dashboard/debug-route.js`.

- Express router with the endpoints listed in `02-api-design.md`
- Auth: check `Authorization: Bearer <token>` against `options.authToken`
- Use `SCAN` (not `KEYS`) to find rate limit keys
- For each identifier, fetch: current count, ttl, penalty multiplier
- Reset endpoint: `DEL` the window key and the penalty key

**Done when:** `curl /ratelimit/debug` with the right token returns JSON listing tracked identifiers. Without the token, returns 401.

### Task 2.4: Documentation and example app (1 hr)

- Update README with install instructions and the kitchen-sink example
- Create `examples/basic-app.js` — a real Express app demonstrating all features
- Add a brief CHANGELOG.md
- (Optional) publish dry-run with `npm publish --dry-run` to see what would ship

**Done when:** A new developer can clone, `npm install`, `node examples/basic-app.js`, and curl-test all features.

## Stretch goals (if time)

- Token bucket strategy as an alternative to sliding window
- Distributed adaptive metrics (share load info across instances via Redis pub/sub)
- Prometheus metrics endpoint
- TypeScript definitions

## Time budget reality check

If you've never written a Lua script for Redis before, Task 1.2 will take longer than 3 hours. Don't blow Day 1 perfecting it — get a working version, write the failing edge case as a test, and come back to it on Day 2 morning if needed. The other tasks don't depend on the Lua being perfect; they depend on the *interface* of `slidingWindow.check()` being stable.
