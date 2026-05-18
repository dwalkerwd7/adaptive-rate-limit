# 05 — Testing Strategy

## Test layers

```
              ┌─────────────────────────┐
              │  E2E (real Redis)       │   ← 5-10 tests, integration only
              ├─────────────────────────┤
              │  Module integration     │   ← per-module, mocked Redis OK for some
              ├─────────────────────────┤
              │  Unit (pure logic)      │   ← bulk of tests
              └─────────────────────────┘
```

Run real Redis for integration tests. `docker run -p 6379:6379 --rm redis:7-alpine` in a pretest script, or use `testcontainers` if you want it automated.

Use a separate DB index (`db: 15`) for tests so you don't trample local dev data. `FLUSHDB` in `beforeEach`.

## What to test per module

### `strategies/sliding-window.js`

**Unit tests (with real Redis):**
- 100 requests at cost 1, limit 100 → all allowed
- 101st request → blocked, `allowed: 0`, `currentCount: 100`
- After `windowMs` elapses → request allowed again
- Cost 10 with limit 100 → exactly 10 requests allowed, 11th blocked
- Cost 5 + cost 1 = 6 used, 94 remaining

**Edge cases:**
- Request at exactly `now - windowMs` (boundary inclusion)
- Cost > limit (single request bigger than the whole budget) → blocked immediately, nothing written
- windowMs of 1000 with two requests 999ms apart → both in window
- Concurrent calls (Promise.all of 200 requests, limit 100) → exactly 100 allowed
- Empty key (first ever request)

### `identifiers/chain.js`

**Unit tests (no Redis needed):**
- Preset extractors return expected values
- Custom extractor function gets called with `req`
- Null/undefined extracted values are filtered out
- Order of identifiers is preserved
- Special characters in values are normalized/hashed correctly
- Extremely long values are truncated

### `adaptive/load-monitor.js`

**Unit tests:**
- Stub `process.cpuUsage` — feed it values, assert returned factor
- CPU at 50% with threshold 70% → factor 1.0
- CPU at 100% → factor `minFactor`
- CPU at 85% with threshold 70% → factor scales linearly between min and max
- Calling `start()` twice doesn't create two intervals
- `stop()` clears the interval

### `penalty/scorer.js`

**Unit tests (real Redis):**
- First violation → multiplier = 1 + increment
- N violations → multiplier capped at maxMultiplier
- After decayMs of no violations → multiplier back to 1 (key expired)
- `getMultiplier` on missing key returns 1.0
- Concurrent violations don't lose increments (Lua atomicity)

### `inspection.js`

**Unit tests (real Redis):**
- `inspectIdentifier` on missing identifier → returns `null`, not throws
- Seed Redis with known state, assert `inspectIdentifier` returns correct counts, resetAt, and penalty multiplier
- `listActiveIdentifiers` with empty Redis → empty array, valid cursor
- Seed 200 identifiers, paginate through them, assert all are returned exactly once
- `listActiveIdentifiers` with `filterType` only returns matching types
- `getLoadMetrics` when adaptive disabled → returns `{ enabled: false, ... }`, doesn't crash
- `resetIdentifier` removes both window and penalty keys (verify via direct Redis check)
- `resetIdentifier` is idempotent — calling twice doesn't error

### `middleware.js`

**Integration tests:**
- Single-identifier flow (the happy path)
- Multi-identifier: hitting limit on user blocks even from a new IP
- Adaptive: stub load monitor at 0.5, verify effective limit halved
- Penalty applied: 5 violations → 6th request blocked at lower threshold
- Headers set correctly on allowed and blocked responses
- `failOpen: true` and Redis killed mid-test → still 200s with degraded header
- Route cost: POST /expensive (cost 10) hits limit in 10 requests

**Callback tests:**
- `onLimit` fires with correct info object on 429
- `onViolation` fires only when multiplier *changes* (not every blocked request after cap)
- `onDegraded` fires when Redis fails open, gets the actual error object
- `onAllowed` fires on every successful request with correct info
- A callback that throws does NOT crash the middleware (it's logged and swallowed)
- A callback that returns a rejected promise does NOT delay the response

## Burst simulation pattern

```js
async function burst(app, path, count) {
  const results = await Promise.all(
    Array.from({ length: count }, () => request(app).get(path))
  );
  return {
    allowed: results.filter(r => r.status !== 429).length,
    blocked: results.filter(r => r.status === 429).length,
  };
}

// Usage in test
const { allowed, blocked } = await burst(app, '/test', 150);
expect(allowed).toBe(100);
expect(blocked).toBe(50);
```

Note: `Promise.all` doesn't guarantee perfect concurrency at the OS level — Node will pipeline them. For more realistic concurrency, use `autocannon` or `wrk` in a separate stress-test script (not in the main test suite, which should be fast).

## Time-related tests

Don't use real `setTimeout` to wait for windows to expire — your tests will be slow and flaky. Two options:

**Option A: Inject a clock**
```js
const clock = { now: () => Date.now() };
const limiter = createRateLimiter({ ..., clock });

// In test
clock.now = () => Date.now() + 70_000;  // jump 70s forward
```

**Option B: Use `vi.useFakeTimers()`** — but this is annoying because the Lua script uses Redis's clock (the `now` you pass into it), not the JS clock. So Option A (passing `now` to your Lua call) is cleaner.

I'd build the middleware so that `Date.now()` is called once per request and that timestamp flows down into the Lua args. That way Option A is essentially free.

## What NOT to test

- Don't test that ioredis works
- Don't test Express internals
- Don't snapshot-test the README in your test suite (sounds silly, but I've seen it)
- Don't test the Lua script in isolation by parsing it — test its effects via real Redis

## Coverage target

70% line coverage is plenty for a side project. Focus on the *interesting* paths, not the boilerplate. If you find yourself writing a test purely to bump coverage on a getter, skip it.

## Performance smoke test (stretch)

Once everything works, run an `autocannon` against the example app:
```
autocannon -c 50 -d 30 http://localhost:3000/api/test
```

If you see > 5ms p99 latency added by the middleware on a local Redis, something is wrong (probably an unnecessary round-trip). Should be sub-2ms.
