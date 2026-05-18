# 02 — API Design

## Public API

```js
const {
  createRateLimiter,
  // Inspection helpers (for building your own admin UI):
  inspectIdentifier,
  listActiveIdentifiers,
  getLoadMetrics,
  resetIdentifier,
} = require('@you/adaptive-rate-limiter');
```

This library is a *primitive*, not a turnkey solution. It decides allow/deny and exposes inspection data. Building an admin dashboard, wiring logs, or pushing metrics is your job — the library gives you the hooks. See `examples/admin-dashboard/` for a reference implementation.

### `createRateLimiter(options)` → `express.Handler`

The middleware factory. Returns a middleware function suitable for `app.use()` or per-route mounting.

#### Options

```ts
interface RateLimiterOptions {
  // --- Redis ---
  redis: RedisOptions | IORedis;       // ioredis config or existing client
  keyPrefix?: string;                   // default: 'rl:'

  // --- Window ---
  windowMs: number;                     // required, must be >= 1000
  limit: number;                        // required base requests per window

  // --- Identifiers ---
  identifiers?: IdentifierConfig[];     // default: ['ip']
  // Each can be a string preset or { type, extractor } for custom

  // --- Cost weights ---
  routeCosts?: Record<string, number>;  // 'METHOD /path' → cost, plus 'default'
  costResolver?: (req) => number;       // override routeCosts entirely

  // --- Adaptive ---
  adaptive?: {
    enabled?: boolean;                  // default: false
    minFactor?: number;                 // default: 0.3
    maxFactor?: number;                 // default: 1.0
    pollIntervalMs?: number;            // default: 5000
    cpuThreshold?: number;              // % cpu where factor starts dropping, default 70
  };

  // --- Penalty ---
  penalty?: {
    enabled?: boolean;                  // default: false
    maxMultiplier?: number;             // default: 4 (limit dropped to 1/4)
    incrementPerViolation?: number;     // default: 0.25
    decayMs?: number;                   // default: 300_000 (5 min)
  };

  // --- Behavior ---
  failOpen?: boolean;                   // default: true (allow on Redis error)
  skipSuccessfulRequests?: boolean;     // default: false

  // --- Event callbacks (all optional, all fire-and-forget) ---
  onLimit?: (req, res, info) => void;             // fires on 429
  onViolation?: (req, info) => void;              // fires when penalty multiplier increases
  onDegraded?: (req, error) => void;              // fires when Redis fails open
  onAllowed?: (req, info) => void;                // fires on every allowed request (use sparingly — hot path)

  // --- Response ---
  standardHeaders?: boolean;            // default: true (IETF draft headers)
  legacyHeaders?: boolean;              // default: false (X-RateLimit-*)
}
```

#### Identifier presets

| Preset | Extractor |
|---|---|
| `'ip'` | `req.ip` (respects `trust proxy`) |
| `'user'` | `req.user?.id` |
| `'apiKey'` | `req.headers['x-api-key']` |
| `'session'` | `req.sessionID` |

Custom:
```js
identifiers: [
  'ip',
  { type: 'tenant', extractor: (req) => req.headers['x-tenant-id'] },
]
```

If an extractor returns `null`/`undefined`, that identifier is skipped for that request (not treated as the string "undefined").

### Inspection API

These are plain async functions, not Express middleware. Use them to build your own admin route, CLI tool, or dashboard. All require a Redis client and optionally accept the `keyPrefix` used when creating the limiter.

#### `inspectIdentifier(redis, type, value, opts?)` → `Promise<IdentifierState | null>`

Returns the full state for one identifier, or `null` if no record exists.

```ts
interface IdentifierState {
  type: string;
  value: string;                  // the original value (not hashed)
  currentCount: number;
  windowMs: number;
  resetAt: number;                // unix ms
  penaltyMultiplier: number;      // 1.0 if no penalty
  penaltyExpiresAt: number | null;
}
```

#### `listActiveIdentifiers(redis, opts?)` → `Promise<IdentifierSummary[]>`

Returns a paginated list of all currently tracked identifiers. Uses `SCAN` internally (never `KEYS`).

```ts
interface IdentifierSummary {
  type: string;
  valueHash: string;              // hashed — see note below
  currentCount: number;
  penaltyMultiplier: number;
}

// Options
interface ListOptions {
  cursor?: string;                // for pagination, default '0'
  count?: number;                 // hint to SCAN, default 100
  filterType?: string;            // only return identifiers of this type
}
```

**Note on hashing:** since identifier values are hashed before being used as Redis keys (see `04-redis-schema.md`), bulk listing can only return hashes, not original values. If you need the original value for a known identifier, you already have it from the request — call `inspectIdentifier(redis, type, value)` and it'll hash it for you.

#### `getLoadMetrics()` → `LoadMetrics`

Synchronous. Returns the current adaptive load monitor state.

```ts
interface LoadMetrics {
  enabled: boolean;
  currentFactor: number;          // 0.3 to 1.0
  cpuPercent: number;
  lastSampleAt: number;
  cpuThreshold: number;
}
```

#### `resetIdentifier(redis, type, value, opts?)` → `Promise<void>`

Deletes both the window and penalty keys for an identifier. Useful for support workflows ("a customer reports being blocked — clear them and investigate").

## Response contract

### Allowed request
Headers set:
```
RateLimit-Limit: 100
RateLimit-Remaining: 87
RateLimit-Reset: 42
RateLimit-Policy: 100;w=60
```

If multiple identifiers, the *tightest* (lowest remaining) drives the headers.

### Blocked request (429)
```
HTTP/1.1 429 Too Many Requests
Retry-After: 23
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 23

{
  "error": "rate_limited",
  "message": "Too many requests",
  "identifier": "ip",          // which identifier triggered
  "retryAfterMs": 23000,
  "penaltyApplied": true,      // true if penalty multiplier > 1
  "cost": 10                   // cost of this request
}
```

Note: `identifier` reveals *which* identifier triggered but never the value (don't echo back IPs/user IDs). This avoids confirming to an attacker which identifier you're tracking them by.

### Failed open (Redis down)
```
RateLimit-Status: degraded
```
Request passes through, no 429 headers set.

## Info objects passed to callbacks

`onLimit` and `onAllowed` receive `(req, res, info)` / `(req, info)` respectively, where `info` has this shape:

```ts
interface LimitInfo {
  identifier: { type: string };          // no value, see above
  limit: number;                          // effective limit after adjustments
  baseLimit: number;                      // original config limit
  current: number;                        // current count in window
  cost: number;                           // cost of this request
  windowMs: number;
  resetAt: number;                        // unix ms
  adaptiveFactor: number;
  penaltyMultiplier: number;
  allowed: boolean;                       // redundant on onLimit (always false) but useful for shared types
}
```

`onViolation` receives `(req, info)` with this shape:

```ts
interface ViolationInfo {
  identifier: { type: string };
  previousMultiplier: number;
  newMultiplier: number;                  // capped at maxMultiplier
  decayMs: number;
}
```

`onDegraded` receives `(req, error)` — the Express request that triggered the degraded path, and the underlying error from Redis.

**All callbacks are fire-and-forget.** Errors thrown inside callbacks are caught and logged, never bubble up to the request. Don't do heavy work in them — push to a queue if you need to.

## Examples

### Minimal
```js
app.use(createRateLimiter({
  redis: { host: 'localhost' },
  windowMs: 60_000,
  limit: 100,
}));
```

### Full kitchen sink
```js
app.use(createRateLimiter({
  redis: redisClient,
  windowMs: 60_000,
  limit: 100,
  identifiers: ['ip', 'user', 'apiKey'],
  routeCosts: {
    'POST /api/ai/generate': 10,
    'POST /api/upload': 5,
    'GET /api/health': 0,
    default: 1,
  },
  adaptive: { enabled: true, cpuThreshold: 75 },
  penalty: { enabled: true, maxMultiplier: 4 },
  onLimit: (req, res, info) => {
    logger.warn({ info }, 'rate limited');
    metrics.increment('ratelimit.blocked', { type: info.identifier.type });
  },
  onViolation: (req, info) => {
    if (info.newMultiplier >= 3) {
      logger.error({ info, ip: req.ip }, 'repeat offender — investigate');
    }
  },
  onDegraded: (req, error) => {
    logger.error({ err: error }, 'rate limiter degraded — Redis unreachable');
    metrics.increment('ratelimit.degraded');
  },
}));
```

### Per-route mounting (different limits per route)
```js
const aiLimiter = createRateLimiter({ windowMs: 60_000, limit: 10, ... });
const apiLimiter = createRateLimiter({ windowMs: 60_000, limit: 100, ... });

app.post('/api/ai/generate', aiLimiter, handler);
app.use('/api', apiLimiter);
```

### Building your own admin endpoint
```js
const { inspectIdentifier, resetIdentifier } = require('@you/adaptive-rate-limiter');

app.get('/admin/ratelimit/:type/:value', requireAdmin, async (req, res) => {
  const state = await inspectIdentifier(redis, req.params.type, req.params.value);
  if (!state) return res.status(404).json({ error: 'no record' });
  res.json(state);
});

app.delete('/admin/ratelimit/:type/:value', requireAdmin, async (req, res) => {
  await resetIdentifier(redis, req.params.type, req.params.value);
  res.status(204).end();
});
```

The library doesn't mount these routes itself — your auth, your URL structure, your response shape. See `examples/admin-dashboard/` for a complete reference implementation.
