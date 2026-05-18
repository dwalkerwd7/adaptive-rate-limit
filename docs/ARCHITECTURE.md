# 01 — Architecture

## High-level data flow

```
Incoming Request
      │
      ▼
┌─────────────────────────┐
│  Identifier Resolver    │  → builds [ip, userId, apiKey] (whichever exist)
└─────────────────────────┘
      │
      ▼
┌─────────────────────────┐
│  Penalty Lookup         │  → fetches penalty multiplier for each identifier
└─────────────────────────┘
      │
      ▼
┌─────────────────────────┐
│  Adaptive Adjuster      │  → reads current load score, computes effective limit
└─────────────────────────┘
      │
      ▼
┌─────────────────────────┐
│  Cost Resolver          │  → looks up route cost (default 1)
└─────────────────────────┘
      │
      ▼
┌─────────────────────────┐
│  Sliding Window Check   │  → Lua script: ZADD + ZREMRANGEBYSCORE + ZCARD
└─────────────────────────┘
      │
      ├── Allowed ──→ set headers, call next()
      │
      └── Blocked ──→ increment penalty, return 429
```

## Core principles

**Single Lua script for the hot path.** The sliding window check, the cost addition, and the window size lookup all happen in one atomic Lua call. This avoids race conditions and minimizes Redis round-trips.

**Identifiers are independent windows.** If a request hits the limit on IP but not user ID, it's still blocked. Each identifier has its own sorted set in Redis.

**Adaptive and penalty modifiers stack multiplicatively.** Base limit × adaptive factor × (1 / penalty multiplier) = effective limit. Both factors clamp to sensible ranges (see below).

**Failure mode: open by default.** If Redis is unreachable, requests pass through with a warning header. Rate limiting is not a security boundary; it's a load-shedding tool. Treating Redis outages as auth failures would be worse than the DDoS we're trying to prevent.

## Module responsibilities

### `middleware.js`
The orchestrator. Imports everything else and exposes `createRateLimiter(options)` that returns an Express middleware function.

### `strategies/sliding-window.js`
Owns the Lua script. Exposes `check(redis, key, windowMs, limit, cost)` → `{ allowed, remaining, resetAt, currentCount }`.

### `identifiers/chain.js`
Exposes `resolveIdentifiers(req, config)` → `[{ type: 'ip', value: '1.2.3.4' }, { type: 'user', value: 'u_123' }]`. Configurable extractors per identifier type.

### `adaptive/load-monitor.js`
A singleton (per process) that polls `process.cpuUsage()` and `process.memoryUsage()` every N ms. Exposes `getLoadFactor()` → number between 0.3 and 1.0.
- 0.3 = under high load, tighten limits to 30% of base
- 1.0 = healthy, full limit available

### `penalty/scorer.js`
Exposes `getMultiplier(redis, identifier)` and `recordViolation(redis, identifier)`. Multiplier grows on repeat 429s, decays over time with TTL.

### `inspection.js`
Read-only helpers — `inspectIdentifier`, `listActiveIdentifiers`, `getLoadMetrics`, `resetIdentifier`. Plain async functions, not middleware. Used by `examples/admin-dashboard/` and available for user-built admin tooling.

### `redis/client.js`
Wraps ioredis. Loads Lua scripts on connection. Provides health check.

## Configuration shape (preview, full spec in 02)

```js
createRateLimiter({
  redis: { host: 'localhost', port: 6379 },
  windowMs: 60_000,
  limit: 100,
  identifiers: ['ip', 'user', 'apiKey'],
  routeCosts: {
    'POST /api/ai/generate': 10,
    'GET /api/health': 0,
    default: 1,
  },
  adaptive: { enabled: true, minFactor: 0.3, maxFactor: 1.0 },
  penalty: { enabled: true, maxMultiplier: 4, decayMs: 300_000 },
})
```

## Why ioredis over node-redis

ioredis has first-class `defineCommand()` for registering Lua scripts as named methods. Cleaner than `EVAL`/`EVALSHA` juggling.

## What we are *not* building

- Distributed coordination across multiple Redis nodes (single instance only)
- Client-side libraries — this is server middleware
- A management UI beyond the debug dashboard
- Rate limit "rules engines" with arbitrary boolean logic — keep it declarative
