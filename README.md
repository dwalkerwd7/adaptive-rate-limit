# adaptive-rate-limit

A production-leaning Express middleware that goes beyond `express-rate-limit` with per-route cost weights, adaptive limits under CPU load, identifier chaining, and escalating penalty scoring — all backed by Redis sliding windows.

## How this was produced

I wrote this by hand 50% and used agentic assistance 50% as a learning exercise for rate limiting and what you
can do with it. This is a middleware that is for educational purposes only due to it not being professionally tested
for vulnerabilities with Semgrep or the like.

```bash
npm install @dtl/adaptive-rate-limit
```

**[Live demo](https://derekwalker.tech/arl) · [Full API reference](#api-reference)**

---

## Why not `express-rate-limit`?

| Feature | express-rate-limit | adaptive-rate-limit |
|---|---|---|
| Sliding window in Redis | ✗ (fixed window) | ✓ |
| Per-route cost weights | ✗ | ✓ |
| Adaptive limits under load | ✗ | ✓ |
| Multiple identifiers per request | ✗ | ✓ |
| Penalty scoring for repeat offenders | ✗ | ✓ |

---

## Quick start

```js
import createRateLimiter from '@dtl/adaptive-rate-limit'
import Redis from 'ioredis'

const redis = new Redis({ host: 'localhost', port: 6379 })

app.use(createRateLimiter({
  redis,
  windowMs: 60_000,
  limit: 100,
}))
```

That's it. The middleware sets `RateLimit-*` headers on every response and returns `429 Too Many Requests` when the limit is exceeded.

---

## Kitchen-sink example

```js
import createRateLimiter from '@dtl/adaptive-rate-limit'

app.use(createRateLimiter({
  redis: redisClient,

  // Sliding window of 1 minute, base limit of 100 requests
  windowMs: 60_000,
  limit: 100,

  // Check IP, authenticated user, and API key — block if any one is over limit
  identifiers: ['ip', 'user', 'apiKey'],

  // Expensive endpoints cost more tokens
  routeCosts: {
    'POST /api/ai/generate': 10,
    'POST /api/upload': 5,
    'GET /api/health': 0,   // doesn't count
    default: 1,
  },

  // Tighten limits when the server is under load
  adaptive: {
    enabled: true,
    cpuThreshold: 75,       // start reducing limit above 75% CPU
    minFactor: 0.3,         // never go below 30% of base limit
  },

  // Escalate penalties for repeat offenders
  penalty: {
    enabled: true,
    maxMultiplier: 4,       // worst case: limit drops to 25%
    incrementPerViolation: 0.5,
    decayMs: 300_000,       // penalty expires after 5 min of good behaviour
  },

  // Callbacks (all optional, all fire-and-forget)
  onLimit: (req, res, info) => {
    logger.warn({ info }, 'rate limited')
    metrics.increment('ratelimit.blocked', { type: info.identifier.type })
  },
  onViolation: (req, info) => {
    if (info.newMultiplier >= 3)
      logger.error({ ip: req.ip }, 'repeat offender — investigate')
  },
  onDegraded: (req, error) => {
    logger.error({ err: error }, 'Redis unreachable — failing open')
  },
}))
```

---

## API reference

### `createRateLimiter(options)` → `express.RequestHandler`

#### Required options

| Option | Type | Description |
|---|---|---|
| `redis` | `Redis \| RedisOptions` | ioredis instance or connection config |
| `windowMs` | `number` | Window size in ms (min 1000) |
| `limit` | `number` | Base request limit per window |

#### Identifiers

```js
// Built-in presets
identifiers: ['ip', 'user', 'apiKey', 'session']

// Custom extractor
identifiers: [
  'ip',
  { type: 'tenant', extractor: (req) => req.headers['x-tenant-id'] },
]
```

Extractors that return `null`/`undefined` are silently skipped for that request.

#### Route costs

```js
routeCosts: {
  'POST /api/expensive': 10,
  'GET /api/cheap': 1,
  default: 1,          // fallback for unlisted routes
}

// Or a function
costResolver: (req) => parseInt(req.headers['x-cost'] ?? '1', 10)
```

#### Adaptive load

```js
adaptive: {
  enabled: true,
  cpuThreshold: 70,    // % CPU where limiting starts (default 70)
  minFactor: 0.3,      // floor factor (default 0.3)
  maxFactor: 1.0,      // ceiling factor (default 1.0)
  pollIntervalMs: 5000, // how often to sample CPU (default 5000)
}
```

The effective limit at any moment is `floor(limit × loadFactor)`, always at least 1.

#### Penalty scoring

```js
penalty: {
  enabled: true,
  maxMultiplier: 4,          // limit → limit/4 at worst (default 4)
  incrementPerViolation: 0.5, // added to multiplier per 429 (default 0.5)
  decayMs: 300_000,           // TTL reset on each violation (default 300 000)
}
```

#### Other options

| Option | Default | Description |
|---|---|---|
| `keyPrefix` | `'rl'` | Redis key prefix |
| `failOpen` | `true` | Allow requests when Redis is down |
| `standardHeaders` | `true` | Set `RateLimit-*` headers (IETF draft) |
| `onLimit` | — | Called on every 429 |
| `onViolation` | — | Called when penalty multiplier increases |
| `onDegraded` | — | Called when Redis fails open |
| `onAllowed` | — | Called on every allowed request (hot path — use carefully) |

### Inspection helpers

Plain async functions for building admin tooling. Not Express middleware.

```js
import {
  inspectIdentifier,
  listActiveIdentifiers,
  getLoadMetrics,
  resetIdentifier,
} from '@dtl/adaptive-rate-limit'
```

#### `inspectIdentifier(redis, type, value, opts?)`

Returns the full state for one identifier, or `null` if no record exists.

```js
const state = await inspectIdentifier(redis, 'ip', '1.2.3.4', { windowMs: 60_000 })
// {
//   type: 'ip', value: '1.2.3.4', currentCount: 42,
//   windowMs: 60000, resetAt: 1234567890000,
//   penaltyMultiplier: 2.0, penaltyExpiresAt: 1234567890000
// }
```

#### `listActiveIdentifiers(redis, opts?)`

Paginated scan of all tracked identifiers. Uses `SCAN` internally.

```js
const { cursor, identifiers } = await listActiveIdentifiers(redis, {
  cursor: '0',
  count: 100,
  filterType: 'ip',   // optional — filter by identifier type
})
```

#### `getLoadMetrics()`

Synchronous. Returns the current load monitor state.

```js
const { enabled, currentFactor, cpuPercent, cpuThreshold } = getLoadMetrics()
```

#### `resetIdentifier(redis, type, value, opts?)`

Clears both the window and penalty for an identifier. Useful for support workflows.

```js
await resetIdentifier(redis, 'ip', '1.2.3.4')
```

---

## Response headers

**Allowed request:**
```
RateLimit-Limit: 100
RateLimit-Remaining: 87
RateLimit-Reset: 1714000000000
RateLimit-Policy: 100;w=60
```

**Blocked (429):**
```
HTTP/1.1 429 Too Many Requests
Retry-After: 23
RateLimit-Remaining: 0
```

When multiple identifiers are configured, headers reflect the tightest one (lowest remaining).

---

## Running the demo

```bash
docker run -p 6379:6379 redis:7-alpine
cd examples/demo && npm start
# → http://localhost:3001
```

Three endpoint cards share a 10-second window. Hit `/api/crunch` repeatedly to spike CPU and watch the adaptive load factor drop in real time.

---

## Requirements

- Node.js 18+
- Redis 7+
- Express 5+
